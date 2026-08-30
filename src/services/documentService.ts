import { PDFParse } from 'pdf-parse';

export const MAX_FILES = 3;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_PAGES = 100;
export const MAX_TOTAL_TEXT_CHARS = 250_000;

export class DocumentProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentProcessingError';
  }
}

export interface DocumentPage {
  source_file: string;
  page_number: number;
  text: string;
}

export interface UploadedPdfFile {
  originalname: string;
  buffer: Buffer;
  size: number;
  mimetype?: string;
}

export async function extractPdfPages(
  files: UploadedPdfFile[]
): Promise<DocumentPage[]> {
  if (!files || files.length === 0) {
    throw new DocumentProcessingError('No PDF files were supplied.');
  }
  if (files.length > MAX_FILES) {
    throw new DocumentProcessingError('A maximum of 3 PDF files can be analyzed.');
  }

  const pages: DocumentPage[] = [];
  const seenFilenames = new Set<string>();
  let totalBytes = 0;
  let totalPages = 0;
  let totalTextChars = 0;

  for (const file of files) {
    const filename = (file.originalname || '').trim();
    if (!filename) {
      throw new DocumentProcessingError('Every uploaded file needs a filename.');
    }
    if (seenFilenames.has(filename)) {
      throw new DocumentProcessingError('Uploaded PDF filenames must be unique.');
    }
    seenFilenames.add(filename);

    if (!filename.toLowerCase().endsWith('.pdf')) {
      throw new DocumentProcessingError(
        `${filename} is not a PDF file. Upload files with a .pdf extension.`
      );
    }

    if (file.size > MAX_FILE_BYTES) {
      throw new DocumentProcessingError(
        `${filename} exceeds the 10 MB per-file limit.`
      );
    }

    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new DocumentProcessingError(
        'The combined PDF upload exceeds the 20 MB limit.'
      );
    }

    if (!file.buffer.subarray(0, 5).toString().startsWith('%PDF-')) {
      throw new DocumentProcessingError(
        `${filename} is not a readable PDF file.`
      );
    }

    let parser: PDFParse | null = null;
    try {
      parser = new PDFParse({ data: file.buffer });
      const textResult = await parser.getText();

      const numPages = textResult.total || textResult.pages.length;
      if (numPages === 0) {
        throw new DocumentProcessingError(`${filename} contains no pages.`);
      }

      totalPages += numPages;
      if (totalPages > MAX_TOTAL_PAGES) {
        throw new DocumentProcessingError(
          'The combined upload exceeds the 100-page limit.'
        );
      }

      const filePages: DocumentPage[] = [];
      for (const page of textResult.pages) {
        const trimmed = (page.text || '').trim();
        if (trimmed) {
          filePages.push({
            source_file: filename,
            page_number: page.num,
            text: trimmed,
          });
        }
      }

      if (filePages.length === 0) {
        throw new DocumentProcessingError(
          `${filename} has no extractable text.`
        );
      }

      for (const page of filePages) {
        totalTextChars += page.text.length;
        if (totalTextChars > MAX_TOTAL_TEXT_CHARS) {
          throw new DocumentProcessingError(
            'The extracted PDF text exceeds the 250,000-character limit.'
          );
        }
        pages.push(page);
      }
    } catch (err: any) {
      if (err instanceof DocumentProcessingError) {
        throw err;
      }
      throw new DocumentProcessingError(
        `${filename} is unreadable or malformed.`
      );
    } finally {
      if (parser) {
        try {
          await parser.destroy();
        } catch {
          // ignore cleanup error
        }
      }
    }
  }

  if (pages.length === 0) {
    throw new DocumentProcessingError('The supplied PDFs have no extractable text.');
  }

  return pages;
}

export function formatPageBlocks(pages: DocumentPage[]): string {
  return pages
    .map(
      (page) =>
        `--- FILE: ${page.source_file} | PAGE: ${page.page_number} ---\n${page.text}`
    )
    .join('\n\n');
}
