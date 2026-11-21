"""The server module reads its login settings when imported; the tests start without login."""

import os

os.environ.setdefault("AUTH_MODE", "local")
