"""`unswbc submit`: upload a bot to the contest server."""

from __future__ import annotations

import io
import pathlib
import time
import uuid
import zipfile

from . import api, auth
from .errors import fail
from .project import NoBotfile, Project, ProjectError

MAX_ZIP_BYTES = 4 * 1024 * 1024


def _zip(project: Project) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(project.path / "bot.toml", "bot.toml")
        for source in project.sources:
            if source != "bot.toml":
                archive.write(project.path / source, source)
    return buffer.getvalue()


def _multipart(fields: dict[str, str], filename: str, blob: bytes) -> tuple[bytes, str]:
    edge = f"unswbc{uuid.uuid4().hex}"
    out = bytearray()
    for name, value in fields.items():
        out += f'--{edge}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    out += f'--{edge}\r\nContent-Disposition: form-data; name="zip"; filename="{filename}"\r\n'.encode()
    out += b"Content-Type: application/zip\r\n\r\n" + blob + b"\r\n"
    out += f"--{edge}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={edge}"


def execute(directory: str | None, name: str | None, description: str | None) -> int:
    path = pathlib.Path(directory or ".")
    try:
        project = Project.from_dir(path)
        project.collect_sources()
    except (NoBotfile, ProjectError) as error:
        return fail(f"{path}: {error}")
    if not project.sources:
        return fail("no files matched project.include, so the zip would hold no bot")

    token = auth.key()
    if not token:
        return fail(f"no API key for {api.server()}; run `unswbc auth set <token>`")

    blob = _zip(project)
    if len(blob) > MAX_ZIP_BYTES:
        return fail(f"the zip is {len(blob) / (1024 * 1024):.1f} MB, over the 4 MB limit")

    label = name or f"{path.resolve().name}-{time.strftime('%Y-%m-%d-%H%M')}"
    fields = {"name": label, "language": project.language}
    if description:
        fields["description"] = description
    body, content_type = _multipart(fields, f"{path.resolve().name}.zip", blob)

    print(f"uploading {len(project.sources) + 1} files ({len(blob) // 1024} KB) to {api.server()}")
    try:
        reply = api.request("submissions", key=token, method="POST", body=body, content_type=content_type)
    except api.ApiError as error:
        if error.status in (401, 403):
            return fail(f"{error}\n  make a key at {api.server()}/team,"
                        " then `unswbc auth set <token>`")
        return fail(str(error))
    print(f"submitted {label} as v{reply.get('version', '?')} ({reply.get('status', 'processing')})")
    print(f"watch it build at {api.server()}/submissions")
    return 0
