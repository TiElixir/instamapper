"""Graph query endpoints with filter params."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.database import Database
from app.deps import get_database
from app.schemas import AccountStatus, GraphEdge, GraphNode, GraphResponse, RelationshipType

router = APIRouter(prefix="/graph", tags=["graph"])


def _status(value: str) -> AccountStatus:
    try:
        return AccountStatus(value)
    except ValueError:
        return AccountStatus.ERROR


def build_graph_payload(
    db: Database,
    verified_only: bool = False,
    hide_private: bool = False,
    min_followers: int | None = None,
    only_connected: bool = False,
    limit_nodes: int | None = None,
) -> GraphResponse:
    users = db.list_users(limit=20000)
    edges = db.list_edges(limit=100000)

    user_by_id = {u.id: u for u in users}
    username_of = {u.id: u.username for u in users}

    included: set[int] = set()
    for user in users:
        if verified_only and not user.verified:
            continue
        if hide_private and user.is_private:
            continue
        if min_followers is not None and (user.follower_count or 0) < min_followers:
            continue
        included.add(user.id)

    nodes: dict[int, GraphNode] = {uid: _node_from_user(user_by_id[uid]) for uid in included}
    edges_out: list[GraphEdge] = []
    connected_uids: set[int] = set()

    for edge in edges:
        src, tgt = edge.source_user_id, edge.target_user_id
        if src not in user_by_id or tgt not in user_by_id:
            continue
        # ``follows`` is the one canonical edge representation. It is written
        # only when the collector sees an account in a follower/following list.
        # Do not render legacy inverse observations as additional graph links.
        if edge.relationship_type != RelationshipType.FOLLOWS.value:
            continue
        if src not in included or tgt not in included:
            continue
        edges_out.append(
            GraphEdge(
                id=f"{username_of[src]}-{username_of[tgt]}-{RelationshipType.FOLLOWS.value}",
                source=username_of[src],
                target=username_of[tgt],
                relationship_type=RelationshipType.FOLLOWS,
                first_seen_at=edge.first_seen_at,
                last_seen_at=edge.last_seen_at,
                observation_count=edge.observation_count,
            )
        )
        connected_uids.add(src)
        connected_uids.add(tgt)

    if only_connected:
        nodes = {k: v for k, v in nodes.items() if k in connected_uids}

    edge_pairs = {(e.source, e.target) for e in edges_out}
    for e in edges_out:
        if (e.target, e.source) in edge_pairs:
            e.mutual = True

    if limit_nodes is not None and limit_nodes > 0 and len(nodes) > limit_nodes:
        # Prioritize nodes with higher degree or follower count
        deg_map: dict[str, int] = {}
        for e in edges_out:
            deg_map[e.source] = deg_map.get(e.source, 0) + 1
            deg_map[e.target] = deg_map.get(e.target, 0) + 1
        sorted_nodes = sorted(
            nodes.values(),
            key=lambda n: (deg_map.get(n.username, 0), n.follower_count or 0),
            reverse=True,
        )[:limit_nodes]
        kept_usernames = {n.username for n in sorted_nodes}
        node_list = sorted(sorted_nodes, key=lambda n: n.username)
        edges_out = [e for e in edges_out if e.source in kept_usernames and e.target in kept_usernames]
    else:
        node_list = sorted(nodes.values(), key=lambda n: n.username)
    filters = {
        "verified_only": verified_only,
        "hide_private": hide_private,
        "min_followers": min_followers,
        "only_connected": only_connected,
        "limit_nodes": limit_nodes,
    }
    return GraphResponse(
        nodes=node_list,
        edges=edges_out,
        node_count=len(node_list),
        edge_count=len(edges_out),
        filters=filters,
    )


def _node_from_user(user) -> GraphNode:
    return GraphNode(
        id=str(user.id),
        username=user.username,
        instagram_id=user.instagram_id,
        follower_count=user.follower_count,
        following_count=user.following_count,
        post_count=user.post_count,
        verified=user.verified,
        is_private=user.is_private,
        status=_status(user.status),
    )


@router.get("", response_model=GraphResponse)
async def get_graph(
    verified_only: bool = Query(default=False),
    hide_private: bool = Query(default=False),
    min_followers: int | None = Query(default=None, ge=0),
    only_connected: bool = Query(default=False),
    limit_nodes: int | None = Query(default=None, ge=1, le=5000),
    db: Database = Depends(get_database),
) -> GraphResponse:
    return build_graph_payload(
        db,
        verified_only=verified_only,
        hide_private=hide_private,
        min_followers=min_followers,
        only_connected=only_connected,
        limit_nodes=limit_nodes,
    )
