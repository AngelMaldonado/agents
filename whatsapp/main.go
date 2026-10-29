// The WhatsApp bridge: one linked device (whatsmeow) shared by every agent of an instance.
//
// It only speaks to the Agents server, on the internal Docker network, with a shared secret:
//   GET  /status   linked or not, the number, and the QR to scan while pairing
//   POST /pair     start pairing (a new QR every ~20 s until it is scanned or times out)
//   POST /logout   unlink the device; the session is deleted
//   POST /send     {phone, text, files: [{name, mime, data}]} to one person
// and forwards every direct message it receives to AGENTS_URL/internal/whatsapp/inbound.
// Routing, permissions and replies are the server's: this process knows no agents.
package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
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

const maxFile = 10 << 20

var (
	secret    = os.Getenv("AGENTS_WHATSAPP_SECRET")
	agentsURL = strings.TrimRight(os.Getenv("AGENTS_URL"), "/")
	digits    = regexp.MustCompile(`^[0-9]{8,15}$`)
)

type bridge struct {
	mu        sync.Mutex
	container *sqlstore.Container
	client    *whatsmeow.Client
	state     string // "unlinked", "pairing", "connecting", "connected"
	qr        string // PNG, base64, while pairing
	lastError string
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
	b := &bridge{container: container, state: "unlinked"}
	if err := b.load(ctx); err != nil {
		log.Printf("load: %v", err)
	}
	http.HandleFunc("/status", b.guard(b.status))
	http.HandleFunc("/pair", b.guard(b.pair))
	http.HandleFunc("/logout", b.guard(b.logout))
	http.HandleFunc("/send", b.guard(b.send))
	addr := ":" + envOr("PORT", "8790")
	log.Printf("whatsapp bridge on %s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

func envOr(k, v string) string {
	if s := os.Getenv(k); s != "" {
		return s
	}
	return v
}

// load reconnects the device linked before a restart, if there is one.
func (b *bridge) load(ctx context.Context) error {
	device, err := b.container.GetFirstDevice(ctx)
	if err != nil {
		return err
	}
	b.newClient(device)
	if device.ID == nil {
		return nil
	}
	b.set("connecting", "", "")
	return b.client.Connect()
}

func (b *bridge) newClient(device *store.Device) {
	c := whatsmeow.NewClient(device, waLog.Stdout("client", "WARN", false))
	c.AddEventHandler(b.onEvent)
	b.mu.Lock()
	b.client = c
	b.mu.Unlock()
}

func (b *bridge) set(state, qr, lastError string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.state, b.qr, b.lastError = state, qr, lastError
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

func (b *bridge) status(w http.ResponseWriter, _ *http.Request) {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := map[string]any{"state": b.state, "error": b.lastError}
	if b.qr != "" {
		out["qr"] = b.qr
	}
	if b.client != nil && b.client.Store.ID != nil {
		out["phone"] = b.client.Store.ID.User
		out["name"] = b.client.Store.PushName
	}
	reply(w, http.StatusOK, out)
}

func (b *bridge) pair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	b.mu.Lock()
	busy := b.state == "pairing" || (b.client != nil && b.client.Store.ID != nil)
	b.mu.Unlock()
	if busy {
		reply(w, http.StatusConflict, map[string]string{"error": "Ya hay un número vinculado o una vinculación en curso."})
		return
	}
	device, err := b.container.GetFirstDevice(r.Context())
	if err != nil {
		reply(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	b.newClient(device)
	b.set("pairing", "", "")
	go b.runPairing()
	reply(w, http.StatusAccepted, map[string]string{"state": "pairing"})
}

// runPairing shows each QR code until one is scanned; the channel must exist before Connect.
func (b *bridge) runPairing() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	ch, err := b.client.GetQRChannel(ctx)
	if err != nil {
		b.set("unlinked", "", err.Error())
		return
	}
	if err := b.client.Connect(); err != nil {
		b.set("unlinked", "", err.Error())
		return
	}
	for item := range ch {
		switch item.Event {
		case "code":
			png, err := qrcode.Encode(item.Code, qrcode.Medium, 320)
			if err != nil {
				b.set("unlinked", "", err.Error())
				return
			}
			b.set("pairing", base64.StdEncoding.EncodeToString(png), "")
		case "success":
			b.set("connected", "", "")
			return
		default:
			msg := item.Event
			if item.Error != nil {
				msg = item.Error.Error()
			}
			b.client.Disconnect()
			b.set("unlinked", "", "La vinculación terminó: "+msg)
			return
		}
	}
}

func (b *bridge) logout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	if b.client != nil && b.client.Store.ID != nil {
		if err := b.client.Logout(r.Context()); err != nil {
			// Unlinked from the phone already: drop the local session anyway.
			_ = b.client.Store.Delete(r.Context())
		}
	}
	if b.client != nil {
		b.client.Disconnect()
	}
	b.set("unlinked", "", "")
	reply(w, http.StatusOK, map[string]string{"state": "unlinked"})
}

type file struct {
	Name string `json:"name"`
	Mime string `json:"mime"`
	Data string `json:"data"`
}

func (b *bridge) send(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Phone string `json:"phone"`
		Text  string `json:"text"`
		Files []file `json:"files"`
	}
	if r.Method != http.MethodPost || json.NewDecoder(http.MaxBytesReader(w, r.Body, 60<<20)).Decode(&in) != nil || !digits.MatchString(in.Phone) {
		reply(w, http.StatusBadRequest, map[string]string{"error": "phone (8-15 digits), text and files"})
		return
	}
	if b.client == nil || !b.client.IsLoggedIn() {
		reply(w, http.StatusServiceUnavailable, map[string]string{"error": "No hay un número de WhatsApp vinculado."})
		return
	}
	to := types.NewJID(in.Phone, types.DefaultUserServer)
	if strings.TrimSpace(in.Text) != "" {
		if _, err := b.client.SendMessage(r.Context(), to, &waE2E.Message{Conversation: proto.String(in.Text)}); err != nil {
			reply(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
	}
	for _, f := range in.Files {
		if err := b.sendFile(r.Context(), to, f); err != nil {
			reply(w, http.StatusBadGateway, map[string]string{"error": fmt.Sprintf("%s: %v", f.Name, err)})
			return
		}
	}
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}

func (b *bridge) sendFile(ctx context.Context, to types.JID, f file) error {
	data, err := base64.StdEncoding.DecodeString(f.Data)
	if err != nil || len(data) == 0 || len(data) > maxFile {
		return errors.New("archivo vacío, inválido o de más de 10 MB")
	}
	image := strings.HasPrefix(f.Mime, "image/")
	kind := whatsmeow.MediaDocument
	if image {
		kind = whatsmeow.MediaImage
	}
	up, err := b.client.Upload(ctx, data, kind)
	if err != nil {
		return err
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
	_, err = b.client.SendMessage(ctx, to, msg)
	return err
}

func (b *bridge) onEvent(evt any) {
	switch e := evt.(type) {
	case *events.Connected:
		b.set("connected", "", "")
	case *events.LoggedOut:
		b.set("unlinked", "", "WhatsApp cerró la sesión de este dispositivo.")
	case *events.Message:
		go b.forward(e)
	}
}

// forward sends one direct message (text, caption, image or document) to the Agents server.
func (b *bridge) forward(e *events.Message) {
	if e.Info.IsFromMe || e.Info.IsGroup || e.Info.Chat.IsBroadcastList() || e.Info.Chat.Server == types.BroadcastServer {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	phone := b.phoneOf(ctx, e.Info.MessageSource)
	if phone == "" {
		log.Printf("message %s: no phone number for %s", e.Info.ID, e.Info.Sender)
		return
	}
	m := e.Message
	text := m.GetConversation()
	if text == "" {
		text = m.GetExtendedTextMessage().GetText()
	}
	var files []file
	add := func(name, mime string, msg whatsmeow.DownloadableMessage, length uint64) {
		if length > maxFile {
			text += fmt.Sprintf("\n\n(«%s» pasa de 10 MB y no se recibió.)", name)
			return
		}
		data, err := b.client.Download(ctx, msg)
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
	body, _ := json.Marshal(map[string]any{"id": string(e.Info.ID), "phone": phone, "name": e.Info.PushName, "text": text, "files": files})
	for attempt := 0; attempt < 5; attempt++ {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, agentsURL+"/internal/whatsapp/inbound", bytes.NewReader(body))
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
		log.Printf("forward %s (try %d): %v", e.Info.ID, attempt+1, err)
		time.Sleep(time.Duration(attempt+1) * 3 * time.Second)
	}
}

// phoneOf: WhatsApp addresses many chats by LID; the phone number is the alternate address or the LID map.
func (b *bridge) phoneOf(ctx context.Context, s types.MessageSource) string {
	for _, j := range []types.JID{s.Sender, s.SenderAlt} {
		if j.Server == types.DefaultUserServer && digits.MatchString(j.User) {
			return j.User
		}
	}
	if s.Sender.Server == types.HiddenUserServer {
		if pn, err := b.client.Store.LIDs.GetPNForLID(ctx, s.Sender); err == nil && digits.MatchString(pn.User) {
			return pn.User
		}
	}
	return ""
}
