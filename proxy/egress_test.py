import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from egress import internal_target, is_public, pick_public  # noqa: E402

INTERNAL = ["sonos.cubytest.space", "Music.Cubytest.Space"]


class Internal(unittest.TestCase):
    def test_listed_hosts_go_to_traefik(self):
        self.assertEqual(internal_target("sonos.cubytest.space", 443, INTERNAL, "traefik"), ("traefik", 443))
        self.assertEqual(internal_target("MUSIC.cubytest.space.", 80, INTERNAL, "traefik"), ("traefik", 80))

    def test_only_listed_hosts_and_web_ports(self):
        self.assertIsNone(internal_target("komodo.cubytest.space", 443, INTERNAL, "traefik"))
        self.assertIsNone(internal_target("evilsonos.cubytest.space", 443, INTERNAL, "traefik"))
        self.assertIsNone(internal_target("sonos.cubytest.space.evil.com", 443, INTERNAL, "traefik"))
        self.assertIsNone(internal_target("sonos.cubytest.space", 22, INTERNAL, "traefik"))
        self.assertIsNone(internal_target("sonos.cubytest.space", 8080, INTERNAL, "traefik"))

    def test_without_an_upstream_nothing_is_internal(self):
        self.assertIsNone(internal_target("sonos.cubytest.space", 443, INTERNAL, None))
        self.assertIsNone(internal_target("sonos.cubytest.space", 443, INTERNAL, ""))
        self.assertIsNone(internal_target("sonos.cubytest.space", 443, None, "traefik"))


class Public(unittest.TestCase):
    def test_public_addresses(self):
        for a in ["77.42.16.34", "1.1.1.1", "2606:4700:4700::1111"]:
            self.assertTrue(is_public(a), a)

    def test_everything_else_is_refused(self):
        for a in [
            "192.168.20.247",  # the LAN (Traefik on reko-5)
            "172.16.1.2",  # Traefik's Docker network
            "10.0.0.1",
            "100.64.0.27",  # the tailnet (CGNAT)
            "127.0.0.1",
            "169.254.169.254",  # cloud metadata
            "0.0.0.0",
            "224.0.0.1",
            "::1",
            "fe80::1%eth0",
            "fd00::1",
            "::ffff:192.168.20.247",
            "not-an-ip",
        ]:
            self.assertFalse(is_public(a), a)

    def test_pick_public(self):
        self.assertEqual(pick_public(["2606:4700::1", "104.16.0.1", "104.16.0.1"]), "104.16.0.1")
        self.assertEqual(pick_public(["2606:4700::1"]), "2606:4700::1")
        self.assertIsNone(pick_public([]))
        # One private answer is enough to refuse the name (no half-trusted rebinding).
        self.assertIsNone(pick_public(["104.16.0.1", "192.168.20.247"]))


if __name__ == "__main__":
    unittest.main()
