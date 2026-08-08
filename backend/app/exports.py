"""Graph export helpers (JSON and CSV for v1; GraphML/GEXF as extension points)."""
from __future__ import annotations

import csv
import io
import json

from app.schemas import GraphEdge, GraphNode


def export_graph_json(nodes: list[GraphNode], edges: list[GraphEdge]) -> str:
    payload = {
        "nodes": [node.model_dump(mode="json") for node in nodes],
        "edges": [edge.model_dump(mode="json") for edge in edges],
    }
    return json.dumps(payload, indent=2, default=str)


def export_graph_csv(nodes: list[GraphNode], edges: list[GraphEdge]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["type", "id", "username", "instagram_id", "follower_count", "following_count", "verified", "private", "relationship_source", "relationship_target", "mutual", "first_seen_at", "last_seen_at"])
    for node in nodes:
        writer.writerow(
            [
                "node",
                node.id,
                node.username,
                node.instagram_id or "",
                node.follower_count or "",
                node.following_count or "",
                int(node.verified),
                int(node.is_private),
                "",
                "",
                "",
                "",
                "",
            ]
        )
    for edge in edges:
        writer.writerow(
            [
                "edge",
                edge.id,
                "",
                "",
                "",
                "",
                "",
                "",
                edge.source,
                edge.target,
                int(edge.mutual),
                edge.first_seen_at.isoformat() if edge.first_seen_at else "",
                edge.last_seen_at.isoformat() if edge.last_seen_at else "",
            ]
        )
    return buffer.getvalue()
