from datetime import datetime, timezone

from app.parser import normalize_count, parse_following_rows, parse_profile
from app.schemas import AccountStatus

PROFILE_HTML = """
<html><body>
<script>
window._sharedData = {"entry_data":{"ProfilePage":[{"graphql":{"user":{
  "id":"123456789",
  "full_name":"Ada Lovelace",
  "biography":"First programmer",
  "external_url":"https://example.com",
  "category_name":"Writer",
  "is_verified":true,
  "is_private":false,
  "edge_followed_by":{"count":1234567},
  "edge_follow":{"count":123},
  "edge_owner_to_timeline_media":{"count":42},
  "profile_pic_url_hd":"https://cdn.example.com/pic.jpg"
}}}]}}
</script>
</body></html>
"""


def test_normalize_count_variants():
    assert normalize_count("1.2K") == 1200
    assert normalize_count("3M") == 3_000_000
    assert normalize_count("12,400") == 12400
    assert normalize_count("800") == 800
    assert normalize_count("1,2K") == 1200
    assert normalize_count(None) is None
    assert normalize_count("nope") is None
    assert normalize_count(42) == 42


def test_parse_profile_full():
    profile = parse_profile("ada", PROFILE_HTML)
    assert profile.username == "ada"
    assert profile.instagram_id == "123456789"
    assert profile.display_name == "Ada Lovelace"
    assert profile.bio == "First programmer"
    assert profile.follower_count == 1_234_567
    assert profile.following_count == 123
    assert profile.post_count == 42
    assert profile.verified is True
    assert profile.is_private is False
    assert profile.website == "https://example.com"
    assert profile.category == "Writer"
    assert profile.status == AccountStatus.AVAILABLE


def test_parse_profile_unavailable():
    profile = parse_profile("ghost", "<html>no data</html>")
    assert profile.status == AccountStatus.UNAVAILABLE or profile.status == AccountStatus.ERROR
    assert profile.username == "ghost"


def test_parse_profile_private():
    html = """
    <script>
    window._sharedData = {"entry_data":{"ProfilePage":[{"graphql":{"user":{
      "id":"7","is_private":true,"is_verified":false,"edge_followed_by":{"count":10},
      "edge_follow":{"count":3},"full_name":"P"
    }}}]}}
    </script>
    """
    profile = parse_profile("private_user", html)
    assert profile.status == AccountStatus.PRIVATE
    assert profile.is_private is True


def test_parse_following_rows():
    html = """
    <div role="dialog">
      <a href="/alice/">Alice</a>
      <a href="/bob/">Bob</a>
      <a href="/alice/">Alice</a>
      <a href="/explore/">not usernames</a>
    </div>
    """
    rows = parse_following_rows(html)
    assert rows == ["alice", "bob"]


def test_parse_profile_visible_count_fallback():
    html = '<script>window._sharedData = {}</script><div>1.5K followers</div>'
    profile = parse_profile("x", html)
    assert profile.follower_count == 1500
    assert profile.status == AccountStatus.AVAILABLE
