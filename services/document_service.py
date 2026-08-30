from dataclasses import dataclass
from io import BytesIO
from typing import Sequence

from pypdf import PdfReader
from pypdf.errors import PdfReadError
from werkzeug.datastructures import FileStorage


MAX_FILES = 3
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 20 * 1024 * 1024
MAX_TOTAL_PAGES = 100
MAX_TOTAL_TEXT_CHARS = 250_000


class DocumentProcessingError(ValueError):
    """A user-facing PDF input or extraction error."""


@dataclass(frozen=True)
class DocumentPage:
    source_file: str
    page_number: int
    text: str


def extract_pdf_pages(files: Sequence[FileStorage]) -> list[DocumentPage]:
    if not files:
        raise DocumentProcessingError("No PDF files were supplied.")
    if len(files) > MAX_FILES:
        raise DocumentProcessingError("A maximum of 3 PDF files can be analyzed.")

    pages: list[DocumentPage] = []
    seen_filenames: set[str] = set()
    total_bytes = 0
    total_pages = 0
    total_text_chars = 0

    for uploaded_file in files:
        filename = (uploaded_file.filename or "").strip()
        if not filename:
            raise DocumentProcessingError("Every uploaded file needs a filename.")
        if filename in seen_filenames:
            raise DocumentProcessingError(
                "Uploaded PDF filenames must be unique."
            )
        seen_filenames.add(filename)

        if not filename.lower().endswith(".pdf"):
            raise DocumentProcessingError(
                f"{filename} is not a PDF file. Upload files with a .pdf extension."
            )

        file_bytes = uploaded_file.stream.read(MAX_FILE_BYTES + 1)
        file_size = len(file_bytes)
        if file_size > MAX_FILE_BYTES:
            raise DocumentProcessingError(
                f"{filename} exceeds the 10 MB per-file limit."
            )

        total_bytes += file_size
        if total_bytes > MAX_TOTAL_BYTES:
            raise DocumentProcessingError(
                "The combined PDF upload exceeds the 20 MB limit."
            )

        if not file_bytes.startswith(b"%PDF-"):
            raise DocumentProcessingError(
                f"{filename} is not a readable PDF file."
            )

        try:
            reader = PdfReader(BytesIO(file_bytes), strict=False)
            if reader.is_encrypted:
                raise DocumentProcessingError(
                    f"{filename} is encrypted and cannot be analyzed."
                )

            file_page_count = len(reader.pages)
            if file_page_count == 0:
                raise DocumentProcessingError(f"{filename} contains no pages.")
            total_pages += file_page_count
            if total_pages > MAX_TOTAL_PAGES:
                raise DocumentProcessingError(
                    "The combined upload exceeds the 100-page limit."
                )

            file_has_text = False
            for page_index, page in enumerate(reader.pages, start=1):
                try:
                    page_text = (page.extract_text() or "").strip()
                except Exception as error:
                    raise DocumentProcessingError(
                        f"{filename} contains a page whose text could not be read."
                    ) from error

                if page_text:
                    file_has_text = True
                    total_text_chars += len(page_text)
                    if total_text_chars > MAX_TOTAL_TEXT_CHARS:
                        raise DocumentProcessingError(
                            "The extracted PDF text exceeds the 250,000-character limit."
                        )
                    pages.append(
                        DocumentPage(
                            source_file=filename,
                            page_number=page_index,
                            text=page_text,
                        )
                    )

            if not file_has_text:
                raise DocumentProcessingError(
                    f"{filename} has no extractable text."
                )
        except DocumentProcessingError:
            raise
        except (PdfReadError, OSError, ValueError) as error:
            raise DocumentProcessingError(
                f"{filename} is unreadable or malformed."
            ) from error

    if not pages:
        raise DocumentProcessingError("The supplied PDFs have no extractable text.")
    return pages


def format_page_blocks(pages: Sequence[DocumentPage]) -> str:
    return "\n\n".join(
        f"--- FILE: {page.source_file} | PAGE: {page.page_number} ---\n{page.text}"
        for page in pages
    )