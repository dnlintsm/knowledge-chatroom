"""Outgoing HTTP for the paper sources, in one place so tests can replace it.

Two kinds of address go out. get() asks the sources this server is configured
with (OpenAlex, arXiv). get_public() fetches a link that came out of their
answers, a paper's PDF, which could point anywhere: it only goes to https on a
public address, checked again on every redirect (issue #289).
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import os
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

USER_AGENT = "knowledge-chatroom-papers/0.1 (+https://github.com/dnlintsm/knowledge-chatroom)"
TIMEOUT = float(os.environ.get("PAPERS_HTTP_TIMEOUT", "30"))
# The most a source's JSON or feed answer may weigh.
MAX_API_BYTES = 20_000_000
MAX_REDIRECTS = 5

# Query parameters that identify this deployment to a source (openalex.py adds
# them). They stay out of error messages, which Claude and the user read.
PRIVATE_PARAMS = frozenset({"api_key", "mailto"})


class SourceError(Exception):
    """A paper source refused or failed; the message is meant for Claude."""


def shown(url: str) -> str:
    """The URL as an error message may show it: without the query's private parameters."""
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    kept = [(name, value) for name, value in query if name not in PRIVATE_PARAMS]
    if len(kept) == len(query):
        return url
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(kept, safe=":|,*")))


def _read(response: Any, url: str, max_bytes: int) -> bytes:
    data = response.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise SourceError(f"{shown(url)} is larger than {max_bytes // 1_000_000} MB")
    return data


def _refused(err: urllib.error.HTTPError, url: str) -> SourceError:
    if err.code == 404:
        return SourceError(f"Not found: {shown(url)}")
    if err.code == 429:
        return SourceError("The paper source is rate limiting us; try again in a minute.")
    return SourceError(f"{shown(url)} answered {err.code}")


def get(url: str, *, accept: str = "application/json", max_bytes: int = MAX_API_BYTES) -> bytes:
    """An answer from a source this server is configured with (OPENALEX_URL, ARXIV_URL)."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return _read(response, url, max_bytes)
    except urllib.error.HTTPError as err:
        raise _refused(err, url) from err
    except (urllib.error.URLError, TimeoutError) as err:
        raise SourceError(f"Couldn't reach {shown(url)}: {getattr(err, 'reason', err)}") from err


def _public_ip(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global


def check_public(url: str) -> urllib.parse.SplitResult:
    """
    Refuses a link this server shouldn't follow: anything but https (file:,
    ftp:, plain http), and a host that is spelled as a private, loopback or
    link-local address. A name is checked where it is resolved: public_address().
    """
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname
    if parts.scheme != "https" or not host:
        raise SourceError(f"{shown(url)} isn't an https link, so it isn't fetched.")
    try:
        literal = _public_ip(host)
    except ValueError:
        literal = host != "localhost" and not host.endswith((".localhost", ".local", ".internal"))
    if not literal:
        raise SourceError(f"{shown(url)} points inside the network, so it isn't fetched.")
    return parts


def public_address(host: str, port: int) -> tuple[str, int]:
    """An address `host` resolves to, once every one of them is public; refuses otherwise."""
    try:
        found = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as err:
        raise SourceError(f"Couldn't find {host}: {err}") from err
    addresses = [str(info[4][0]) for info in found]
    if not addresses or not all(_public_ip(a) for a in addresses):
        raise SourceError(f"{host} points inside the network, so it isn't fetched.")
    return addresses[0], port


class _PinnedConnection(http.client.HTTPSConnection):
    """
    Connects to the address public_address() approved, with the certificate
    still checked against the name. Resolving once to check and again to
    connect would let the name change in between.

    Through a proxy (HTTPS_PROXY) the proxy resolves the name, so only the
    link itself is checked here; keeping the proxy off private addresses is
    then the proxy's job.
    """

    tunnelled = False

    def set_tunnel(self, *args: Any, **kwargs: Any) -> None:
        self.tunnelled = True
        super().set_tunnel(*args, **kwargs)

    def connect(self) -> None:
        if self.tunnelled:
            super().connect()
            return
        address = public_address(self.host, self.port)
        sock = socket.create_connection(address, self.timeout)
        self.sock = _TLS.wrap_socket(sock, server_hostname=self.host)


class _PinnedHandler(urllib.request.HTTPSHandler):
    def https_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        return self.do_open(_PinnedConnection, req, context=_TLS)  # type: ignore[arg-type]


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Redirects come back as errors, so get_public() checks each new address itself."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_TLS = ssl.create_default_context()
_PUBLIC = urllib.request.build_opener(_PinnedHandler(), _NoRedirects())


def _open_public(url: str, accept: str) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    return _PUBLIC.open(request, timeout=TIMEOUT)


def get_public(url: str, *, accept: str = "application/pdf", max_bytes: int) -> bytes:
    """
    Fetches a link taken from a source's answer, such as a paper's PDF: https
    only, to public addresses only, at most `max_bytes`, and every redirect
    checked the same way.
    """
    first = url
    for _hop in range(MAX_REDIRECTS + 1):
        check_public(url)
        try:
            with _open_public(url, accept) as response:
                return _read(response, url, max_bytes)
        except urllib.error.HTTPError as err:
            location = err.headers.get("Location") if err.headers else None
            if err.code not in (301, 302, 303, 307, 308) or not location:
                raise _refused(err, url) from err
            url = urllib.parse.urljoin(url, location)
        except (urllib.error.URLError, TimeoutError) as err:
            reason = getattr(err, "reason", err)
            if isinstance(reason, SourceError):
                raise reason from err
            raise SourceError(f"Couldn't reach {shown(url)}: {reason}") from err
    raise SourceError(f"{shown(first)} redirects too many times.")


def get_json(url: str) -> Any:
    try:
        return json.loads(get(url))
    except json.JSONDecodeError as err:
        raise SourceError(f"{shown(url)} didn't answer JSON") from err
