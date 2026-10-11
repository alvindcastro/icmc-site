import secrets


def new_id(prefix: str) -> str:
    """An opaque random identifier with a short type prefix, such as `req_3f9a...`."""
    return f"{prefix}_{secrets.token_hex(12)}"
