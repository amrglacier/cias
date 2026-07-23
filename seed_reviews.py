import json
import urllib.request
import urllib.error

SB_URL = "https://snycievdfcyoytthxspm.supabase.co"
SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNueWNpZXZkZmN5b3l0dGh4c3BtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDI4MDEyOCwiZXhwIjoyMDk5ODU2MTI4fQ.NJGxkf_wb_VlSUDJ-YwCzXZ_98BfzzGa0goONcCLDYM"

# First get prediction IDs
req = urllib.request.Request(
    SB_URL + "/rest/v1/predictions?select=id,match_id,version_tag&order=id.asc",
    headers={
        "apikey": SB_KEY,
        "Authorization": "Bearer " + SB_KEY,
    },
    method="GET"
)
resp = urllib.request.urlopen(req, timeout=30)
predictions = json.loads(resp.read().decode("utf-8"))
print("Predictions:", json.dumps(predictions, indent=2))

# Create reviews for M001 and M002 (M003 is still in-play, no review yet)
reviews = [
    {
        "match_id": "EPL-2026-M001",
        "prediction_id": None,  # will fill below
        "actual_result": "home_win",
        "actual_ft": "2-0",
        "actual_ht": "1-0",
        "attribution_code": "A1",
        "attribution_party": "logic",
        "attribution_detail": "胜负方向正确，总进球接近(预测2-1实际2-0)，逻辑型预判准确",
        "error_type": "none",
        "is_upset": False
    },
    {
        "match_id": "EPL-2026-M002",
        "prediction_id": None,
        "actual_result": "draw",
        "actual_ft": "1-1",
        "actual_ht": "0-0",
        "attribution_code": "A1",
        "attribution_party": "logic",
        "attribution_detail": "胜负方向正确，总进球一致(预测1-1实际1-1)，完美命中",
        "error_type": "none",
        "is_upset": False
    },
    {
        "match_id": "EPL-2026-M003",
        "prediction_id": None,
        "actual_result": "draw",
        "actual_ft": "1-1",
        "actual_ht": "0-0",
        "attribution_code": "D1",
        "attribution_party": "logic",
        "attribution_detail": "实际为冷门平局，预测客胜未命中，交叉讨论2轮未对齐导致forced_degrade",
        "error_type": "direction_error",
        "is_upset": True
    }
]

# Match FINAL predictions to reviews
for review in reviews:
    for pred in predictions:
        if pred["match_id"] == review["match_id"] and pred["version_tag"] == "FINAL":
            review["prediction_id"] = pred["id"]
            break

print("\nInserting reviews...")
for i, review in enumerate(reviews):
    body = json.dumps(review).encode("utf-8")
    req = urllib.request.Request(
        SB_URL + "/rest/v1/review_results",
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
        result = json.loads(resp.read().decode("utf-8"))
        print("Inserted review", i+1, "- match:", review["match_id"], "code:", review["attribution_code"])
    except urllib.error.HTTPError as e:
        print("HTTP Error for review", i+1, ":", e.code, e.read().decode("utf-8")[:200])
    except Exception as e:
        print("Error for review", i+1, ":", e)
