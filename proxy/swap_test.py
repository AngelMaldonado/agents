import base64
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from swap import domain_matches, intercept, run_token, swap_headers  # noqa: E402

GH = {"domains": ["api.github.com", "github.com"], "placeholder": "agk_gh", "value": "ghp_real"}
WILD = {"domains": ["*.example.com"], "placeholder": "agk_ex", "value": "ex_real"}


def basic(user: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


class Swap(unittest.TestCase):
    def test_run_token(self):
        self.assertEqual(run_token(basic("run", "tok")), "tok")
        self.assertIsNone(run_token(basic("other", "tok")))
        self.assertIsNone(run_token(basic("run", "")))
        self.assertIsNone(run_token("Bearer tok"))
        self.assertIsNone(run_token(None))
        self.assertIsNone(run_token("Basic !!!"))

    def test_domains(self):
        self.assertTrue(domain_matches("API.github.com.", "api.github.com"))
        self.assertFalse(domain_matches("evilapi.github.com", "api.github.com"))
        self.assertTrue(domain_matches("a.example.com", "*.example.com"))
        self.assertFalse(domain_matches("example.com", "*.example.com"))
        self.assertFalse(domain_matches("badexample.com", "*.example.com"))

    def test_intercept_only_hosts_with_keys(self):
        self.assertTrue(intercept([GH], "api.github.com"))
        self.assertFalse(intercept([GH], "pypi.org"))
        self.assertFalse(intercept(None, "api.github.com"))

    def test_bearer_and_custom_headers_swapped_only_towards_the_domain(self):
        headers = [("Authorization", "Bearer agk_gh"), ("X-Api-Key", "agk_gh"), ("Accept", "*/*")]
        self.assertEqual(
            swap_headers(headers, "api.github.com", [GH, WILD]),
            [("Authorization", "Bearer ghp_real"), ("X-Api-Key", "ghp_real"), ("Accept", "*/*")],
        )
        # The same placeholder sent anywhere else stays a placeholder.
        self.assertEqual(swap_headers(headers, "attacker.dev", [GH, WILD]), headers)

    def test_basic_is_decoded_swapped_and_reencoded(self):
        out = swap_headers([("Authorization", basic("x-access-token", "agk_gh"))], "github.com", [GH])
        self.assertEqual(out, [("Authorization", basic("x-access-token", "ghp_real"))])
        untouched = [("Authorization", basic("user", "pass"))]
        self.assertEqual(swap_headers(untouched, "github.com", [GH]), untouched)

    def test_one_rule_does_not_leak_into_another_domain(self):
        headers = [("Authorization", "Bearer agk_ex agk_gh")]
        self.assertEqual(swap_headers(headers, "a.example.com", [GH, WILD]), [("Authorization", "Bearer ex_real agk_gh")])


if __name__ == "__main__":
    unittest.main()
