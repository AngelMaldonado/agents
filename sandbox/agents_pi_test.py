"""The owner's pi wrapper must not update the runtime behind Agents' validated image."""
import contextlib
import io
from pathlib import Path
import runpy
import sys
import unittest
from unittest.mock import patch

WRAPPER = Path(__file__).parent / "bin" / "agents-pi"


class Delegated(Exception):
    pass


class ManagedPi(unittest.TestCase):
    def invoke(self, *args):
        output = io.StringIO()
        with (
            patch.object(sys, "argv", [str(WRAPPER), *args]),
            patch("os.execv", side_effect=Delegated) as execute,
            patch("os.execve") as launch,
            patch("urllib.request.urlopen") as request,
            contextlib.redirect_stderr(output),
            contextlib.redirect_stdout(output),
        ):
            try:
                runpy.run_path(str(WRAPPER), run_name="__main__")
            except SystemExit as result:
                code = result.code
            except Delegated:
                code = None
            request.assert_not_called()
            launch.assert_not_called()
        return code, output.getvalue(), execute

    def test_self_updates_explain_management_without_executing_pi_or_npm(self):
        for args in (
            ("update",),
            ("update", "self"),
            ("update", "pi"),
            ("update", "--self"),
            ("update", "--force"),
            ("update", "--all"),
            ("update", "--self", "--extensions"),
            ("update", "self", "--extensions"),
        ):
            with self.subTest(args=args):
                code, message, execute = self.invoke(*args)
                self.assertEqual(code, 1)  # No update took place: do not report success to scripts.
                self.assertIn("gestionada por Agents", message)
                self.assertIn("imagen de la computadora", message)
                self.assertIn("No se ejecutó npm ni se cambió la versión", message)
                self.assertIn("menú Computadora", message)
                execute.assert_not_called()

    def test_package_model_help_and_other_commands_still_delegate_unchanged(self):
        for args in (
            ("update", "--extensions"),
            ("update", "npm:example"),
            ("update", "--extension", "self"),
            ("update", "--extension", "pi"),
            ("update", "--models"),
            ("update", "--help"),
            ("update", "-h"),
            ("mcp", "list"),
            ("--version",),
        ):
            with self.subTest(args=args):
                code, message, execute = self.invoke(*args)
                self.assertIsNone(code)
                self.assertEqual(message, "")
                execute.assert_called_once_with("/usr/local/bin/pi", ["/usr/local/bin/pi", *args])


if __name__ == "__main__":
    unittest.main()
