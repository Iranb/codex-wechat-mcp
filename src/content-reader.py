#!/usr/bin/env python3
"""Bounded parsing of one verified local attachment; no macros or external links."""
import io
import hashlib
import json
import os
import resource
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import shutil
import zipfile
import xml.etree.ElementTree as ET

LIMIT = 30000
MAX_XML = 8 * 1024 * 1024
resource.setrlimit(resource.RLIMIT_CPU, (18, 18))
resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))


class ContentError(Exception):
    pass


def fail(code):
    raise ContentError(code)


def xml_member(z, name):
    info = z.getinfo(name)
    if info.file_size > MAX_XML:
        fail('document_structure_limit')
    data = z.read(name)
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        fail('unsafe_document_structure')
    return ET.fromstring(data)


def office(path):
    z = zipfile.ZipFile(path)
    infos = z.infolist()
    names = [x.filename for x in infos]
    if len(infos) > 5000 or len(set(names)) != len(names) or sum(x.file_size for x in infos) > 64 * 1024 * 1024:
        fail('document_structure_limit')
    for x in infos:
        if x.flag_bits & 1 or x.filename.startswith('/') or '\\' in x.filename or '..' in x.filename.split('/') or \
                stat.S_ISLNK(x.external_attr >> 16) or 'vbaproject' in x.filename.lower():
            fail('unsafe_document_structure')
        if x.file_size > 20 * 1024 * 1024 or x.file_size > max(1024 * 1024, x.compress_size * 300):
            fail('document_structure_limit')
    types = z.read('[Content_Types].xml').lower()
    if b'macroenabled' in types:
        fail('unsupported_macro_document')
    return z


def read_docx(data):
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    out = []
    with office(io.BytesIO(data)) as z:
        root = xml_member(z, 'word/document.xml')
        for p in root.findall('.//w:p', ns):
            out.append(''.join(t.text or '' for t in p.findall('.//w:t', ns)))
            if sum(len(x) + 1 for x in out) > LIMIT:
                return '\n'.join(out)[:LIMIT], True, {}
    return '\n'.join(out), False, {}


def read_xlsx(data):
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    rid = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
    out = []
    with office(io.BytesIO(data)) as z:
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            root = xml_member(z, 'xl/sharedStrings.xml')
            shared = [''.join(t.text or '' for t in si.findall('.//s:t', ns)) for si in root.findall('s:si', ns)]
        rels = xml_member(z, 'xl/_rels/workbook.xml.rels')
        targets = {r.attrib['Id']: r.attrib.get('Target', '') for r in rels if r.attrib.get('TargetMode') != 'External'}
        workbook = xml_member(z, 'xl/workbook.xml')
        cell_count = 0
        for sheet in workbook.findall('.//s:sheet', ns)[:32]:
            target = targets.get(sheet.attrib.get(rid), '')
            member = target.lstrip('/') if target.startswith('/xl/') else 'xl/' + target
            if not member.startswith('xl/worksheets/') or '..' in member.split('/') or '\\' in member:
                fail('unsafe_document_structure')
            out.append('Sheet: ' + sheet.attrib.get('name', '')[:200])
            root = xml_member(z, member)
            for row in root.findall('.//s:row', ns):
                cells = []
                for c in row.findall('s:c', ns):
                    cell_count += 1
                    if cell_count > 10000:
                        return '\n'.join(out)[:LIMIT], True, {'formulasExecuted': False}
                    v = c.find('s:v', ns)
                    value = v.text or '' if v is not None else ''
                    if c.attrib.get('t') == 's':
                        index = int(value)
                        if index < 0 or index >= len(shared): fail('invalid_spreadsheet')
                        value = shared[index]
                    elif c.attrib.get('t') == 'inlineStr':
                        value = ''.join(t.text or '' for t in c.findall('.//s:t', ns))
                    formula = c.find('s:f', ns)
                    if formula is not None:
                        value += ' [formula text: ' + (formula.text or '')[:500] + '; not executed]'
                    cells.append(c.attrib.get('r', '') + '=' + value[:2000])
                out.append(' | '.join(cells))
                if sum(len(x) + 1 for x in out) > LIMIT:
                    return '\n'.join(out)[:LIMIT], True, {'formulasExecuted': False}
    return '\n'.join(out), False, {'formulasExecuted': False}


def read_pdf(data):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted: fail('encrypted_document')
    out = []; has_text = False
    for i, page in enumerate(reader.pages):
        if i >= 100:
            if not has_text: fail('pdf_no_extractable_text')
            return '\n'.join(out)[:LIMIT], True, {'pages': len(reader.pages)}
        text = page.extract_text() or ''; has_text |= bool(text.strip())
        out.append(f'[Page {i + 1}]\n' + text)
        if sum(len(x) + 1 for x in out) > LIMIT:
            return '\n'.join(out)[:LIMIT], True, {'pages': len(reader.pages)}
    if not has_text:
        fail('pdf_no_extractable_text')
    return '\n'.join(out), False, {'pages': len(reader.pages)}


def render_pdf(path, data):
    from pypdf import PdfReader
    from PIL import Image
    pages = len(PdfReader(io.BytesIO(data), strict=True).pages)
    folder = Path(tempfile.mkdtemp(prefix=path.name + '.pages-', dir=path.parent))
    source = folder / 'input.pdf'
    with source.open('xb') as f: f.write(data)
    os.chmod(source, 0o600)
    executable = os.environ.get('CODEX_WECHAT_PDFTOPPM') or shutil.which('pdftoppm')
    if not executable: fail('pdf_renderer_unavailable')
    subprocess.run([executable, '-f', '1', '-l', '3', '-scale-to', '1600', '-png',
                    str(source), str(folder/'page')], timeout=15, check=True,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    images = sorted(folder.glob('page-*.png'))
    if not images or len(images) > 3: fail('pdf_render_failed')
    for image in images:
        os.chmod(image, 0o600)
        if image.stat().st_size > 10 * 1024 * 1024: fail('image_size_limit')
        with Image.open(image) as pixels: pixels.verify()
    return {'images': [str(x) for x in images], 'text': '', 'truncated': pages > len(images),
            'pages': pages, 'renderedPages': len(images), 'contentSource': 'rendered_pdf_pages'}


def image_input(path, data):
    from PIL import Image, ImageOps
    import warnings
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    Image.MAX_IMAGE_PIXELS = 20000000
    with Image.open(io.BytesIO(data)) as image:
        image.verify()
    with Image.open(io.BytesIO(data)) as source:
        image = ImageOps.exif_transpose(source).convert('RGB')
        original = image.size
        image.thumbnail((2048, 2048))
        buffer = io.BytesIO(); image.save(buffer, format='PNG')
        if buffer.tell() > 10 * 1024 * 1024:
            image.thumbnail((1600, 1600)); buffer = io.BytesIO(); image.save(buffer, format='PNG')
        data = buffer.getvalue()
        if len(data) > 10 * 1024 * 1024: fail('image_size_limit')
        output = path.with_name(path.name + '.input.png')
        try:
            fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as f: f.write(data)
        except FileExistsError:
            info = output.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or output.read_bytes() != data:
                fail('derived_storage_collision')
        return {'imagePath': str(output), 'width': image.width, 'height': image.height,
                'originalWidth': original[0], 'originalHeight': original[1], 'firstFrameOnly': getattr(source, 'n_frames', 1) > 1}


def main():
    path = Path(sys.argv[1]); kind = sys.argv[2]
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 20 * 1024 * 1024:
        fail('private_attachment_required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        current = os.fstat(f.fileno())
        if current.st_ino != info.st_ino or current.st_dev != info.st_dev: fail('attachment_changed')
        data = f.read(20 * 1024 * 1024 + 1)
    if len(data) > 20 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != sys.argv[3]:
        fail('attachment_digest_mismatch')
    if kind == 'image': return image_input(path, data)
    if path.suffix.lower() == '.pdf':
        try: text, truncated, meta = read_pdf(data)
        except ContentError as error:
            if str(error) != 'pdf_no_extractable_text': raise
            return render_pdf(path, data)
    elif path.suffix.lower() == '.docx': text, truncated, meta = read_docx(data)
    elif path.suffix.lower() == '.xlsx': text, truncated, meta = read_xlsx(data)
    elif kind == 'text':
        text = data.decode('utf-8-sig', errors='strict'); truncated = len(text) > LIMIT; text = text[:LIMIT]; meta = {}
    else: fail('unsupported_document_format')
    if not text.strip(): fail('empty_document')
    return {'text': text[:LIMIT], 'truncated': truncated, **meta}


try:
    print(json.dumps({'status': 'ready', **main()}, ensure_ascii=False))
except ContentError as error:
    print(json.dumps({'status': 'failed', 'failure': str(error)}))
except Exception:
    print(json.dumps({'status': 'failed', 'failure': 'content_parse_failed'}))
