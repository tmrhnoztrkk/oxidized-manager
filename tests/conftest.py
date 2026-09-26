import os
import sys
import tempfile
from pathlib import Path

# The app reads its settings at import time: point it at a throw-away data dir first.
_DATA = tempfile.mkdtemp(prefix="oxmgr-test-")
os.environ.update(DATA_DIR=_DATA, OXIDIZED_AUTOSTART="false", BACKUP_SCHEDULER="false",
                  MAX_REMOTE_WORKSPACES="3", SECRET_KEY="test-secret", DEFAULT_LANG="en")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
