import json
import urllib.request
import urllib.error

SB_URL = "https://snycievdfcyoytthxspm.supabase.co"
SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNueWNpZXZkZmN5b3l0dGh4c3BtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDI4MDEyOCwiZXhwIjoyMDk5ODU2MTI4fQ.NJGxkf_wb_VlSUDJ-YwCzXZ_98BfzzGa0goONcCLDYM"

with open("C:/Users/mrglacier/.qianfan/workspace/0f5a172f7a6e46088512349253d2efed/cias/seed_predictions.json", "r", encoding="utf-8") as f:
    data = json.load(f)

# Insert one by one
for i, item in enumerate(data):
    body = json.dumps(item).encode("utf-8")
    req = urllib.request.Request(
        SB_URL + "/rest/v1/predictions",
        data=body,
        headers={
            "apikey": SB_KEY,
            "Authorization": "Bearer " + SB_KEY,
            "Content-Type": "application/json",
            "Prefer": "return=representation"
        },
        method="POST"
    )
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        print("Inserted prediction", i+1, "- match:", item["match_id"], "version:", item["version_tag"])
    except urllib.error.HTTPError as e:
        print("HTTP Error for prediction", i+1, ":", e.code, e.read().decode("utf-8")[:200])
    except Exception as e:
        print("Error for prediction", i+1, ":", e)
