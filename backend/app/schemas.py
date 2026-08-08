"""Pydantic models shared across the API, collector, and storage layers."""
from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class AccountStatus(str, Enum):
    AVAILABLE = "available"
    UNAVAILABLE = "unavailable"
    PRIVATE = "private"
    RATE_LIMITED = "rate_limited"
    BLOCKED = "blocked"
    ERROR = "error"


class RelationshipType(str, Enum):
    FOLLOWS = "follows"          # source follows target
    FOLLOWED_BY = "followed_by"  # source is followed by target


class ScanStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class UserProfile(BaseModel):
    username: str
    instagram_id: str | None = None
    display_name: str | None = None
    bio: str | None = None
    follower_count: int | None = None
    following_count: int | None = None
    post_count: int | None = None
    verified: bool = False
    is_private: bool = False
    website: str | None = None
    picture_url: str | None = None
    category: str | None = None
    status: AccountStatus = AccountStatus.AVAILABLE
    scanned_at: datetime = Field(default_factory=datetime.utcnow)


class RelationshipEdge(BaseModel):
    source: str
    target: str
    relationship_type: RelationshipType
    session_id: int | None = None
    observed_at: datetime = Field(default_factory=datetime.utcnow)


class ScanConfig(BaseModel):
    target: str
    depth: int = Field(default=1, ge=1, le=3)
    cookie_path: str | None = None
    resume: bool = True
    max_workers: int | None = Field(default=None, ge=1, le=16)
    max_following_rows: int | None = Field(default=None, ge=1)


class ScanCreateResponse(BaseModel):
    scan_id: int
    status: ScanStatus
    target: str
    depth: int


class CookieTestRequest(BaseModel):
    cookie_path: str | None = None


class CookieTestResponse(BaseModel):
    valid: bool
    username: str | None = None
    detail: str


class ExtensionQueueItem(BaseModel):
    username: str
    remaining_depth: int = Field(ge=0, le=3)


class ExtensionRelationship(BaseModel):
    username: str
    instagram_id: str | None = None


class ExtensionAccountIngest(BaseModel):
    source_username: str
    depth: int = Field(ge=0, le=3)
    following: list[ExtensionRelationship] = Field(default_factory=list, max_length=10_000)
    pending: list[ExtensionQueueItem] = Field(default_factory=list, max_length=10_000)
    error_type: str | None = None
    error_message: str | None = None


class ExtensionFinishRequest(BaseModel):
    status: ScanStatus = ScanStatus.COMPLETED
    error_message: str | None = None


class ScanSummary(BaseModel):
    id: int
    target: str
    depth: int
    status: ScanStatus
    started_at: datetime | None = None
    finished_at: datetime | None = None
    users_seen: int = 0
    edges_seen: int = 0
    errors: int = 0
    pending_queue_size: int = 0


class ScanDetail(ScanSummary):
    error_summary: dict[str, int] = Field(default_factory=dict)
    recent_errors: list[dict] = Field(default_factory=list)


class UserOut(BaseModel):
    username: str
    instagram_id: str | None = None
    display_name: str | None = None
    bio: str | None = None
    follower_count: int | None = None
    following_count: int | None = None
    post_count: int | None = None
    verified: bool = False
    is_private: bool = False
    website: str | None = None
    picture_url: str | None = None
    category: str | None = None
    status: AccountStatus = AccountStatus.AVAILABLE
    first_seen_at: datetime | None = None
    last_seen_at: datetime | None = None
    snapshot_count: int = 0


class GraphNode(BaseModel):
    id: str
    username: str
    instagram_id: str | None = None
    follower_count: int | None = None
    following_count: int | None = None
    post_count: int | None = None
    verified: bool = False
    is_private: bool = False
    status: AccountStatus = AccountStatus.AVAILABLE


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    relationship_type: RelationshipType
    mutual: bool = False
    first_seen_at: datetime | None = None
    last_seen_at: datetime | None = None
    observation_count: int = 1


class GraphResponse(BaseModel):
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    node_count: int = 0
    edge_count: int = 0
    filters: dict = Field(default_factory=dict)


class AnalysisResult(BaseModel):
    metric: str
    username: str | None = None
    value: float | list | dict | None = None
    detail: dict = Field(default_factory=dict)


class ExportResponse(BaseModel):
    format: str
    filename: str
    content: str
