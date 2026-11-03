// The WhatsApp bridge: the linked numbers (whatsmeow devices) of an Agents instance, any number of them.
//
// It only speaks to the Agents server, on the internal network, with a shared secret. Numbers are keyed
// by their device JID; a pairing in progress by the reference the server gives it (its number's id):
//
//	GET    /numbers                 every linked number: jid, phone, name, state
//	POST   /pairings  {ref}         start linking a new number (a new QR every ~20 s until scanned)
//	GET    /pairings/{ref}          its QR while pairing; jid, phone and name once linked
//	DELETE /pairings/{ref}          stop it
//	DELETE /numbers/{jid}           unlink a number; its session is deleted
//	POST   /numbers/{jid}/send      {phone, text, files: [{name, mime, data}]} to one person
//
// and tells AGENTS_URL/internal/whatsapp/event what happens: a direct message to a number, a pairing
// that linked, a number WhatsApp logged out. Routing, permissions and replies are the server's: this
// process knows no agents or people.
package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	_ "github.com/lib/pq"
	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

const (
	maxFile = 10 << 20
	// Sending like a person: a pause before each message and at most perMinute a minute per number.
	// WhatsApp watches unofficial clients that write fast or in bulk; a number is someone's, keep it safe.
	perMinute = 20
)

var (
	secret    = os.Getenv("AGENTS_WHATSAPP_SECRET")
	agentsURL = strings.TrimRight(os.Getenv("AGENTS_URL"), "/")
	digits    = regexp.MustCompile(`^[0-9]{8,15}$`)
	refs      = regexp.MustCompile(`^[0-9]{1,18}$`)
)

// number is one linked device and its sending pace.
type number struct {
	client *whatsmeow.Client
	send   sync.Mutex  // one message at a time per number
	sent   []time.Time // when the last messages went, for the per-minute cap
}

type pairing struct {
	State  string `json:"state"` // "pairing", "linked", "failed"
	QR     string `json:"qr,omitempty"`
	Error  string `json:"error,omitempty"`
	JID    string `json:"jid,omitempty"`
	Phone  string `json:"phone,omitempty"`
	Name   string `json:"name,omitempty"`
	cancel context.CancelFunc
	client *whatsmeow.Client
}

type bridge struct {
	mu        sync.Mutex
	container *sqlstore.Container
	numbers   map[string]*number  // by device JID
	pairings  map[string]*pairing // by the server's reference
}

func main() {
	if secret == "" || agentsURL == "" {
		log.Fatal("AGENTS_WHATSAPP_SECRET and AGENTS_URL are required")
	}
	ctx := context.Background()
	container, err := sqlstore.New(ctx, "postgres", os.Getenv("WHATSAPP_DATABASE_URL"), waLog.Stdout("store", "WARN", false))
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	b := &bridge{container: container, numbers: map[string]*number{}, pairings: map[string]*pairing{}}
	if err := b.load(ctx); err != nil {
		log.Printf("load: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /numbers", b.guard(b.list))
	mux.HandleFunc("DELETE /numbers/{jid}", b.guard(b.unlink))
	mux.HandleFunc("POST /numbers/{jid}/send", b.guard(b.sendHandler))
	mux.HandleFunc("POST /numbers/{jid}/poll", b.guard(b.pollHandler))
	mux.HandleFunc("POST /numbers/{jid}/typing", b.guard(b.typingHandler))
	mux.HandleFunc("POST /numbers/{jid}/groups", b.guard(b.createGroup))
	mux.HandleFunc("POST /numbers/{jid}/groups/{group}/lock", b.guard(b.lockGroup))
	mux.HandleFunc("POST /numbers/{jid}/groups/{group}/photo", b.guard(b.groupPhoto))
	mux.HandleFunc("POST /pairings", b.guard(b.startPairing))
	mux.HandleFunc("GET /pairings/{ref}", b.guard(b.pairingStatus))
	mux.HandleFunc("DELETE /pairings/{ref}", b.guard(b.stopPairing))
	addr := ":" + envOr("PORT", "8790")
	log.Printf("whatsapp bridge on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func envOr(k, v string) string {
	if s := os.Getenv(k); s != "" {
		return s
	}
	return v
}

// load reconnects every number linked before a restart.
func (b *bridge) load(ctx context.Context) error {
	devices, err := b.container.GetAllDevices(ctx)
	if err != nil {
		return err
	}
	for _, d := range devices {
		if d.ID == nil {
			continue
		}
		c := b.newClient(d)
		b.mu.Lock()
		b.numbers[d.ID.String()] = &number{client: c}
		b.mu.Unlock()
		if err := c.Connect(); err != nil {
			log.Printf("connect %s: %v", d.ID, err)
		}
	}
	log.Printf("%d numbers loaded", len(b.numbers))
	return nil
}

func (b *bridge) newClient(device *store.Device) *whatsmeow.Client {
	c := whatsmeow.NewClient(device, waLog.Stdout("client", "WARN", false))
	c.AddEventHandler(func(evt any) { b.onEvent(c, evt) })
	return c
}

func (b *bridge) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Agents-Secret")), []byte(secret)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		h(w, r)
	}
}

func reply(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	reply(w, code, map[string]string{"error": msg})
}

func stateOf(c *whatsmeow.Client) string {
	switch {
	case c.Store.ID == nil:
		return "unlinked"
	case c.IsLoggedIn():
		return "connected"
	default:
		return "connecting"
	}
}

func (b *bridge) list(w http.ResponseWriter, _ *http.Request) {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := []map[string]string{}
	for jid, n := range b.numbers {
		out = append(out, map[string]string{"jid": jid, "phone": n.client.Store.ID.User, "name": n.client.Store.PushName, "state": stateOf(n.client)})
	}
	reply(w, http.StatusOK, map[string]any{"numbers": out})
}

func (b *bridge) startPairing(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Ref string `json:"ref"`
	}
	if json.NewDecoder(r.Body).Decode(&in) != nil || !refs.MatchString(in.Ref) {
		fail(w, http.StatusBadRequest, "ref")
		return
	}
	b.mu.Lock()
	if p := b.pairings[in.Ref]; p != nil && p.State == "pairing" {
		b.mu.Unlock()
		reply(w, http.StatusOK, p)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	p := &pairing{State: "pairing", cancel: cancel}
	b.pairings[in.Ref] = p
	b.mu.Unlock()
	p.client = b.newClient(b.container.NewDevice())
	go b.runPairing(ctx, in.Ref, p)
	reply(w, http.StatusAccepted, p)
}

// runPairing shows each QR code until one is scanned; the channel must exist before Connect.
func (b *bridge) runPairing(ctx context.Context, ref string, p *pairing) {
	defer p.cancel()
	set := func(f func()) {
		b.mu.Lock()
		f()
		b.mu.Unlock()
	}
	failed := func(msg string) {
		p.client.Disconnect()
		set(func() { p.State, p.QR, p.Error = "failed", "", msg })
	}
	ch, err := p.client.GetQRChannel(ctx)
	if err != nil {
		failed(err.Error())
		return
	}
	if err := p.client.Connect(); err != nil {
		failed(err.Error())
		return
	}
	for item := range ch {
		switch item.Event {
		case "code":
			png, err := qrcode.Encode(item.Code, qrcode.Medium, 320)
			if err != nil {
				failed(err.Error())
				return
			}
			set(func() { p.QR = base64.StdEncoding.EncodeToString(png) })
		case "success":
			id := p.client.Store.ID
			jid := id.String()
			set(func() {
				p.State, p.QR, p.JID, p.Phone, p.Name = "linked", "", jid, id.User, p.client.Store.PushName
				b.numbers[jid] = &number{client: p.client}
			})
			go b.notify(map[string]any{"type": "linked", "ref": ref, "jid": jid, "phone": id.User, "name": p.client.Store.PushName})
			return
		default:
			msg := "La vinculación terminó: " + item.Event
			if item.Event == "timeout" {
				msg = "Se acabó el tiempo para escanear el código."
			} else if item.Error != nil {
				msg = "La vinculación terminó: " + item.Error.Error()
			}
			failed(msg)
			return
		}
	}
}

func (b *bridge) pairingStatus(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	defer b.mu.Unlock()
	p := b.pairings[r.PathValue("ref")]
	if p == nil {
		fail(w, http.StatusNotFound, "No hay una vinculación con esa referencia.")
		return
	}
	reply(w, http.StatusOK, p)
}

func (b *bridge) stopPairing(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	p := b.pairings[r.PathValue("ref")]
	delete(b.pairings, r.PathValue("ref"))
	b.mu.Unlock()
	if p != nil && p.State == "pairing" {
		p.cancel()
	}
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}

func (b *bridge) number(jid string) *number {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.numbers[jid]
}

func (b *bridge) unlink(w http.ResponseWriter, r *http.Request) {
	jid := r.PathValue("jid")
	n := b.number(jid)
	if n == nil {
		reply(w, http.StatusOK, map[string]bool{"ok": true}) // already gone
		return
	}
	if err := n.client.Logout(r.Context()); err != nil {
		// Unlinked from the phone already: drop the local session anyway.
		_ = n.client.Store.Delete(r.Context())
	}
	n.client.Disconnect()
	b.mu.Lock()
	delete(b.numbers, jid)
	b.mu.Unlock()
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}

type file struct {
	Name string `json:"name"`
	Mime string `json:"mime"`
	Data string `json:"data"`
}

func (b *bridge) sendHandler(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Phone string `json:"phone"`
		// Group: a group this number created (its JID), instead of a phone.
		Group string `json:"group"`
		Text  string `json:"text"`
		Files []file `json:"files"`
		// Resolve: a phone that never wrote to this number; WhatsApp says its address (Mexico: 52… or 521…).
		Resolve bool `json:"resolve"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 60<<20)).Decode(&in) != nil ||
		(in.Group == "" && !digits.MatchString(in.Phone)) {
		fail(w, http.StatusBadRequest, "phone (8-15 digits) or group, text and files")
		return
	}
	n := b.number(r.PathValue("jid"))
	if n == nil || !n.client.IsLoggedIn() {
		fail(w, http.StatusServiceUnavailable, "Ese número de WhatsApp no está conectado.")
		return
	}
	to := types.NewJID(in.Phone, types.DefaultUserServer)
	if in.Group != "" {
		g, err := types.ParseJID(in.Group)
		if err != nil || g.Server != types.GroupServer {
			fail(w, http.StatusBadRequest, "group must be a group JID")
			return
		}
		to = g
	} else if in.Resolve {
		found, err := n.client.IsOnWhatsApp(r.Context(), []string{"+" + in.Phone})
		if err != nil || len(found) == 0 || !found[0].IsIn {
			fail(w, http.StatusBadGateway, "Ese teléfono no tiene WhatsApp.")
			return
		}
		to = found[0].JID
	}
	ids, err := n.deliver(r.Context(), to, in.Text, in.Files)
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	reply(w, http.StatusOK, map[string]any{"ok": true, "ids": ids})
}

// typingHandler shows «escribiendo…» to a chat once: the server repeats it while the agent works (WhatsApp
// drops it after ~25 s, or when a message goes out). Not a message: it does not count against the pace.
func (b *bridge) typingHandler(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Phone string `json:"phone"`
		Group string `json:"group"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&in) != nil || (in.Group == "" && !digits.MatchString(in.Phone)) {
		fail(w, http.StatusBadRequest, "phone (8-15 digits) or group")
		return
	}
	n := b.number(r.PathValue("jid"))
	if n == nil || !n.client.IsLoggedIn() {
		fail(w, http.StatusServiceUnavailable, "Ese número de WhatsApp no está conectado.")
		return
	}
	to := types.NewJID(in.Phone, types.DefaultUserServer)
	if g, err := types.ParseJID(in.Group); in.Group != "" && err == nil {
		to = g
	}
	if err := n.client.SendChatPresence(r.Context(), to, types.ChatPresenceComposing, types.ChatPresenceMediaText); err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}

// createGroup makes a group with this number (its admin) and the given phones: one person's group with
// someone's agents (#18). WhatsApp names it; at most 25 characters.
func (b *bridge) createGroup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name   string   `json:"name"`
		Phones []string `json:"phones"`
		// Photo: a JPEG in base64, set right after it is created (best effort: the group stays without it).
		Photo string `json:"photo"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in) != nil || strings.TrimSpace(in.Name) == "" || len(in.Phones) == 0 {
		fail(w, http.StatusBadRequest, "name and phones")
		return
	}
	n := b.number(r.PathValue("jid"))
	if n == nil || !n.client.IsLoggedIn() {
		fail(w, http.StatusServiceUnavailable, "Ese número de WhatsApp no está conectado.")
		return
	}
	query := []string{}
	for _, p := range in.Phones {
		if digits.MatchString(p) {
			query = append(query, "+"+p)
		}
	}
	found, err := n.client.IsOnWhatsApp(r.Context(), query)
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	members := []types.JID{}
	for _, f := range found {
		if f.IsIn {
			members = append(members, f.JID)
		}
	}
	if len(members) == 0 {
		fail(w, http.StatusBadGateway, "Ese teléfono no tiene WhatsApp.")
		return
	}
	name := []rune(strings.TrimSpace(in.Name))
	if len(name) > 25 {
		name = name[:25]
	}
	g, err := n.client.CreateGroup(r.Context(), whatsmeow.ReqCreateGroup{Name: string(name), Participants: members})
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	photo := false
	if in.Photo != "" {
		if data, err := base64.StdEncoding.DecodeString(in.Photo); err == nil {
			_, err = n.client.SetGroupPhoto(r.Context(), g.JID, data)
			photo = err == nil
		}
	}
	reply(w, http.StatusOK, map[string]any{"jid": g.JID.String(), "photo": photo})
}

// groupPhoto sets the picture of a group this number created (a JPEG in base64), or removes it (empty).
func (b *bridge) groupPhoto(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Photo string `json:"photo"`
	}
	g, err := types.ParseJID(r.PathValue("group"))
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&in) != nil || err != nil || g.Server != types.GroupServer {
		fail(w, http.StatusBadRequest, "a group JID and photo")
		return
	}
	var data []byte
	if in.Photo != "" {
		if data, err = base64.StdEncoding.DecodeString(in.Photo); err != nil {
			fail(w, http.StatusBadRequest, "photo must be base64")
			return
		}
	}
	n := b.number(r.PathValue("jid"))
	if n == nil || !n.client.IsLoggedIn() {
		fail(w, http.StatusServiceUnavailable, "Ese número de WhatsApp no está conectado.")
		return
	}
	if _, err := n.client.SetGroupPhoto(r.Context(), g, data); err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}

// lockGroup: closed, only this number writes there (announce); open again, everyone does.
func (b *bridge) lockGroup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Locked bool `json:"locked"`
	}
	g, err := types.ParseJID(r.PathValue("group"))
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&in) != nil || err != nil || g.Server != types.GroupServer {
		fail(w, http.StatusBadRequest, "a group JID and locked")
		return
	}
	n := b.number(r.PathValue("jid"))
	if n == nil || !n.client.IsLoggedIn() {
		fail(w, http.StatusServiceUnavailable, "Ese número de WhatsApp no está conectado.")
		return
	}
	if err := n.client.SetGroupAnnounce(r.Context(), g, in.Locked); err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}

// pollHandler sends a one-choice poll (which agent to talk to) and returns its message id: votes name it.
func (b *bridge) pollHandler(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Phone   string   `json:"phone"`
		Name    string   `json:"name"`
		Options []string `json:"options"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in) != nil || !digits.MatchString(in.Phone) ||
		strings.TrimSpace(in.Name) == "" || len(in.Options) < 1 || len(in.Options) > 12 {
		fail(w, http.StatusBadRequest, "phone, name and 1-12 options")
		return
	}
	n := b.number(r.PathValue("jid"))
	if n == nil || !n.client.IsLoggedIn() {
		fail(w, http.StatusServiceUnavailable, "Ese número de WhatsApp no está conectado.")
		return
	}
	to := types.NewJID(in.Phone, types.DefaultUserServer)
	n.send.Lock()
	defer n.send.Unlock()
	if err := n.pace(r.Context(), to, len(in.Name)); err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	res, err := n.client.SendMessage(r.Context(), to, n.client.BuildPollCreation(in.Name, in.Options, 1))
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	reply(w, http.StatusOK, map[string]string{"id": string(res.ID)})
}

// deliver sends a text and its files in order, one message at a time, at a person's pace. It returns the
// ids of what went out: a reply that quotes one of them goes back to whoever sent it.
func (n *number) deliver(ctx context.Context, to types.JID, text string, files []file) ([]string, error) {
	n.send.Lock()
	defer n.send.Unlock()
	ids := []string{}
	if strings.TrimSpace(text) != "" {
		if err := n.pace(ctx, to, len(text)); err != nil {
			return ids, err
		}
		res, err := n.client.SendMessage(ctx, to, &waE2E.Message{Conversation: proto.String(text)})
		if err != nil {
			return ids, err
		}
		ids = append(ids, string(res.ID))
	}
	for _, f := range files {
		if err := n.pace(ctx, to, 0); err != nil {
			return ids, err
		}
		id, err := n.sendFile(ctx, to, f)
		if err != nil {
			return ids, fmt.Errorf("%s: %v", f.Name, err)
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// pace waits for the per-minute cap, then shows «escribiendo…» for a moment that grows with the text.
func (n *number) pace(ctx context.Context, to types.JID, chars int) error {
	cut := time.Now().Add(-time.Minute)
	kept := n.sent[:0]
	for _, t := range n.sent {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	n.sent = kept
	if len(n.sent) >= perMinute {
		wait := time.Until(n.sent[0].Add(time.Minute))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
	typing := time.Second + time.Duration(min(chars, 600))*5*time.Millisecond // 1 to 4 s
	_ = n.client.SendChatPresence(ctx, to, types.ChatPresenceComposing, types.ChatPresenceMediaText)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(typing):
	}
	_ = n.client.SendChatPresence(ctx, to, types.ChatPresencePaused, types.ChatPresenceMediaText)
	n.sent = append(n.sent, time.Now())
	return nil
}

func (n *number) sendFile(ctx context.Context, to types.JID, f file) (string, error) {
	data, err := base64.StdEncoding.DecodeString(f.Data)
	if err != nil || len(data) == 0 || len(data) > maxFile {
		return "", errors.New("archivo vacío, inválido o de más de 10 MB")
	}
	image := f.Mime == "image/jpeg" || f.Mime == "image/png" || f.Mime == "image/webp"
	kind := whatsmeow.MediaDocument
	if image {
		kind = whatsmeow.MediaImage
	}
	up, err := n.client.Upload(ctx, data, kind)
	if err != nil {
		return "", err
	}
	msg := &waE2E.Message{}
	if image {
		msg.ImageMessage = &waE2E.ImageMessage{URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			Mimetype: proto.String(f.Mime), FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: proto.Uint64(up.FileLength)}
	} else {
		msg.DocumentMessage = &waE2E.DocumentMessage{URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			Mimetype: proto.String(f.Mime), FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: proto.Uint64(up.FileLength),
			FileName: proto.String(f.Name), Title: proto.String(f.Name)}
	}
	res, err := n.client.SendMessage(ctx, to, msg)
	return string(res.ID), err
}

func (b *bridge) onEvent(c *whatsmeow.Client, evt any) {
	switch e := evt.(type) {
	case *events.LoggedOut:
		if c.Store.ID == nil {
			return
		}
		jid := c.Store.ID.String()
		b.mu.Lock()
		delete(b.numbers, jid)
		b.mu.Unlock()
		go b.notify(map[string]any{"type": "logged_out", "number": jid})
	case *events.Message:
		go b.forward(c, e)
	}
}

// forward sends one direct message to a number (text, caption, image or document) to the server.
// Groups come later (#18): for now only one-to-one chats reach an agent.
func (b *bridge) forward(c *whatsmeow.Client, e *events.Message) {
	if c.Store.ID == nil || e.Info.IsFromMe || e.Info.Chat.IsBroadcastList() || e.Info.Chat.Server == types.BroadcastServer {
		return
	}
	// In a group, only the ones Agents created (one person's group with someone's agents) are read.
	group := ""
	if e.Info.IsGroup {
		group = e.Info.Chat.String()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	phone := phoneOf(ctx, c, e.Info.MessageSource)
	if phone == "" {
		log.Printf("message %s: no phone number for %s", e.Info.ID, e.Info.Sender)
		return
	}
	if pu := e.Message.GetPollUpdateMessage(); pu != nil {
		b.vote(ctx, c, e, phone, pu.GetPollCreationMessageKey().GetID())
		return
	}
	// A linked number may be someone's own phone: chats that are not for its agents stay untouched
	// (unread, files not downloaded, nothing forwarded). Only an allow-listed phone that is talking to an
	// awake agent, or that writes /agentes or /agente, goes on: the server decides from the text.
	if !b.allowed(ctx, c.Store.ID.String(), phone, previewText(e.Message), "", group) {
		return
	}
	_ = c.MarkRead(ctx, []types.MessageID{e.Info.ID}, time.Now(), e.Info.Chat, e.Info.Sender) // ✓✓ azules: alguien lo recibió
	m := e.Message
	text := m.GetConversation()
	quoted := ""
	if ext := m.GetExtendedTextMessage(); ext != nil {
		if text == "" {
			text = ext.GetText()
		}
		quoted = ext.GetContextInfo().GetStanzaID()
	}
	var files []file
	add := func(name, mime string, msg whatsmeow.DownloadableMessage, length uint64) {
		if length > maxFile {
			text += fmt.Sprintf("\n\n(«%s» pasa de 10 MB y no se recibió.)", name)
			return
		}
		data, err := c.Download(ctx, msg)
		if err != nil {
			log.Printf("download %s: %v", name, err)
			return
		}
		files = append(files, file{Name: name, Mime: mime, Data: base64.StdEncoding.EncodeToString(data)})
	}
	if img := m.GetImageMessage(); img != nil {
		if text == "" {
			text = img.GetCaption()
		}
		ext := "jpg"
		if strings.Contains(img.GetMimetype(), "png") {
			ext = "png"
		}
		add(fmt.Sprintf("imagen-%s.%s", e.Info.ID, ext), img.GetMimetype(), img, img.GetFileLength())
	}
	if doc := m.GetDocumentMessage(); doc != nil {
		if text == "" {
			text = doc.GetCaption()
		}
		name := doc.GetFileName()
		if name == "" {
			name = "documento-" + string(e.Info.ID)
		}
		add(name, doc.GetMimetype(), doc, doc.GetFileLength())
	}
	if strings.TrimSpace(text) == "" && len(files) == 0 {
		return // stickers, reactions, audio, calls…: nothing an agent can read yet
	}
	b.notify(map[string]any{"type": "message", "number": c.Store.ID.String(), "id": string(e.Info.ID), "phone": phone,
		"name": e.Info.PushName, "text": text, "files": files, "quoted": quoted, "group": group})
}

// previewText is what a message says (its text or a caption), for the server to tell a command apart.
func previewText(m *waE2E.Message) string {
	switch {
	case m.GetConversation() != "":
		return m.GetConversation()
	case m.GetExtendedTextMessage() != nil:
		return m.GetExtendedTextMessage().GetText()
	case m.GetImageMessage() != nil:
		return m.GetImageMessage().GetCaption()
	case m.GetDocumentMessage() != nil:
		return m.GetDocumentMessage().GetCaption()
	}
	return ""
}

// vote: someone picked an agent in the poll this number sent them. Only a vote on the chat's latest poll
// is read; the choices go to the server as the SHA-256 of the option names.
func (b *bridge) vote(ctx context.Context, c *whatsmeow.Client, e *events.Message, phone, poll string) {
	if poll == "" || e.Info.IsGroup || !b.allowed(ctx, c.Store.ID.String(), phone, "", poll, "") {
		return
	}
	v, err := c.DecryptPollVote(ctx, e)
	if err != nil {
		log.Printf("vote %s: %v", e.Info.ID, err)
		return
	}
	options := []string{}
	for _, h := range v.GetSelectedOptions() {
		options = append(options, hex.EncodeToString(h))
	}
	if len(options) == 0 {
		return // a vote taken back
	}
	_ = c.MarkRead(ctx, []types.MessageID{e.Info.ID}, time.Now(), e.Info.Chat, e.Info.Sender)
	b.notify(map[string]any{"type": "vote", "number": c.Store.ID.String(), "phone": phone, "poll": poll, "options": options})
}

// allowed asks the server whether this message may be taken: the phone is in the number's allow list and
// it talks to an awake agent, writes a command or votes on the chat's poll. When the server does not
// answer, the message is left alone: it stays unread on the phone rather than being taken.
func (b *bridge) allowed(ctx context.Context, jid, phone, text, poll, group string) bool {
	body, _ := json.Marshal(map[string]string{"number": jid, "phone": phone, "text": text, "poll": poll, "group": group})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, agentsURL+"/internal/whatsapp/allowed", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Agents-Secret", secret)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("allowed %s: %v", phone, err)
		return false
	}
	defer res.Body.Close()
	var out struct {
		Allowed bool `json:"allowed"`
	}
	return res.StatusCode == http.StatusOK && json.NewDecoder(res.Body).Decode(&out) == nil && out.Allowed
}

// notify tells the server what happened, retrying while it restarts.
func (b *bridge) notify(event map[string]any) {
	body, _ := json.Marshal(event)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for attempt := 0; attempt < 5; attempt++ {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, agentsURL+"/internal/whatsapp/event", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Agents-Secret", secret)
		res, err := http.DefaultClient.Do(req)
		if err == nil {
			res.Body.Close()
			if res.StatusCode < 500 {
				return
			}
			err = fmt.Errorf("status %d", res.StatusCode)
		}
		log.Printf("notify %v (try %d): %v", event["type"], attempt+1, err)
		time.Sleep(time.Duration(attempt+1) * 3 * time.Second)
	}
}

// phoneOf: WhatsApp addresses many chats by LID; the phone number is the alternate address or the LID map.
func phoneOf(ctx context.Context, c *whatsmeow.Client, s types.MessageSource) string {
	for _, j := range []types.JID{s.Sender, s.SenderAlt} {
		if j.Server == types.DefaultUserServer && digits.MatchString(j.User) {
			return j.User
		}
	}
	if s.Sender.Server == types.HiddenUserServer {
		if pn, err := c.Store.LIDs.GetPNForLID(ctx, s.Sender); err == nil && digits.MatchString(pn.User) {
			return pn.User
		}
	}
	return ""
}
