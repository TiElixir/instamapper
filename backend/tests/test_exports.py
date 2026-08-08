import csv
import io
import json

from app.exports import export_graph_csv, export_graph_json
from app.schemas import AccountStatus, GraphEdge, GraphNode, RelationshipType


def _node(name):
    return GraphNode(id=name, username=name, follower_count=10, status=AccountStatus.AVAILABLE)


def test_json_export_roundtrip():
    nodes = [_node("a"), _node("b")]
    edges = [GraphEdge(id="e1", source="a", target="b", relationship_type=RelationshipType.FOLLOWS, mutual=True)]
    text = export_graph_json(nodes, edges)
    payload = json.loads(text)
    assert len(payload["nodes"]) == 2
    assert payload["edges"][0]["mutual"] is True


def test_csv_export_rows():
    nodes = [_node("a")]
    edges = [GraphEdge(id="e1", source="a", target="b", relationship_type=RelationshipType.FOLLOWS)]
    text = export_graph_csv(nodes, edges)
    rows = list(csv.DictReader(io.StringIO(text)))
    types = [r["type"] for r in rows]
    assert types == ["node", "edge"]
    assert rows[1]["relationship_source"] == "a"
    assert rows[1]["relationship_target"] == "b"
