import http.client
import socket
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

import pytest
import uvicorn
from fastapi import FastAPI

from tests.support import API


@contextmanager
def serving(app: FastAPI) -> Iterator[int]:
    """Run the application under uvicorn on a free local port, as the README's command does."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    try:
        assert server.started
        yield listener.getsockname()[1]
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()


@pytest.mark.parametrize(("path", "status"), [("/healthz", 200), (f"{API}/nothing-here", 404)])
def test_a_running_server_stamps_each_response_with_exactly_one_date(
    app: FastAPI, path: str, status: int
) -> None:
    # The frontend judges session, quote and preview deadlines by this header. Two copies would
    # be unreadable to it, so the application must leave the header to the server.
    with serving(app) as port:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        connection.request("GET", path)
        response = connection.getresponse()
        response.read()
        connection.close()

    assert response.status == status
    dates = response.headers.get_all("Date")
    assert dates is not None and len(dates) == 1
    assert abs((parsedate_to_datetime(dates[0]) - datetime.now(UTC)).total_seconds()) < 5
    assert response.headers["X-Request-ID"].startswith("req_")
