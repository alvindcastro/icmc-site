import logging

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.errors import ApiError, error_response
from app.ids import new_id

logger = logging.getLogger(__name__)


class RequestContext:
    """Names each request, keeps API responses out of caches and answers a crash in the envelope.

    The `Date` header is left to the server: uvicorn adds it to every response, and a second
    copy from here would make the header unreadable to the frontend.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = new_id("req")
        scope.setdefault("state", {})["request_id"] = request_id
        status = 0

        async def stamped(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = MutableHeaders(scope=message)
                headers["X-Request-ID"] = request_id
                if scope["path"].startswith("/api/"):
                    headers["Cache-Control"] = "no-store"
            await send(message)

        try:
            await self.app(scope, receive, stamped)
        except Exception:
            # The traceback stays in the server log, found by the ID the client was given.
            logger.exception("%s %s %s failed", request_id, scope["method"], scope["path"])
            if status:
                raise
            failure = ApiError(500, "internal_error", "The server could not complete the request.")
            await error_response(request_id, failure)(scope, receive, stamped)
        # The path is logged without its query string, which can carry search text.
        logger.info("%s %s %s %s", request_id, scope["method"], scope["path"], status)
