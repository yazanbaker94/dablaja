import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("DABLAJA_DB", str(Path(tempfile.gettempdir()) / "unused-dablaja-test.db"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dablaja import DablajaStore  # noqa: E402


class UsageStoreTests(unittest.TestCase):
    def test_usage_is_deduplicated_and_aggregated_without_page_data(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DablajaStore(Path(directory) / "dablaja.db")
            self.assertEqual(store.add_usage("event-1234567890123456", "youtube", 3_600_000), "ok")
            self.assertEqual(store.add_usage("event-1234567890123456", "youtube", 3_600_000), "duplicate")
            self.assertEqual(store.add_usage("event-abcdefghijklmnop", "other", 1_800_000), "ok")

            stats = store.public_stats()
            self.assertEqual(stats["total_hours"], 1.5)
            self.assertEqual(stats["total_sessions"], 2)
            self.assertEqual(stats["platforms"]["youtube"], 66.7)
            self.assertEqual(stats["platforms"]["other"], 33.3)

            with store._db() as connection:
                columns = {
                    row[1]
                    for table in ("usage_event_ids", "usage_daily")
                    for row in connection.execute(f"PRAGMA table_info({table})")
                }
            self.assertFalse({"url", "title", "audio", "transcript", "api_key", "install_id"} & columns)


if __name__ == "__main__":
    unittest.main()
