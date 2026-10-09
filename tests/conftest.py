import os
import tempfile

# Keep test designs out of the real data directory.
os.environ.setdefault("ECKO_DATA_DIR", tempfile.mkdtemp(prefix="ecko-test-"))
