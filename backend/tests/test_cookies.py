import json

import pytest

from app.cookies import CookieLoadError, load_cookie_file


def test_load_yaml_cookies(tmp_path):
    f = tmp_path / "cookies.yaml"
    f.write_text(
        "cookies:\n  - name: sessionid\n    value: abc\n    domain: .instagram.com\n    path: /\n",
        encoding="utf-8",
    )
    cookies = load_cookie_file(f)
    assert cookies[0]["name"] == "sessionid"
    assert cookies[0]["value"] == "abc"
    assert cookies[0]["domain"] == ".instagram.com"


def test_load_json_cookies(tmp_path):
    f = tmp_path / "cookies.json"
    f.write_text(json.dumps([{"name": "csrftoken", "value": "tok", "domain": ".instagram.com"}]), encoding="utf-8")
    cookies = load_cookie_file(f)
    assert cookies[0]["name"] == "csrftoken"


def test_missing_file_raises(tmp_path):
    with pytest.raises(CookieLoadError):
        load_cookie_file(tmp_path / "nope.yaml")


def test_empty_or_invalid_raises(tmp_path):
    f = tmp_path / "bad.yaml"
    f.write_text("cookies: []\n", encoding="utf-8")
    with pytest.raises(CookieLoadError):
        load_cookie_file(f)

    f2 = tmp_path / "missing.yaml"
    f2.write_text("- name: no_value\n", encoding="utf-8")
    with pytest.raises(CookieLoadError):
        load_cookie_file(f2)
