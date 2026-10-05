/**
 * questions-parser.js
 * Parses a .docx questionnaire and extracts question IDs + text.
 * Question lines are identified by a leading code like C1, P6, R1a, M12, etc.
 */

const mammoth = require('mammoth');

const QUESTION_ID_RE = /^([A-Z][A-Z0-9]?[0-9]+[a-z]?)\s+(Required|Optional)(.*)/;

/**
 * Parse questions from a .docx file.
 * @param {string} docxPath - Absolute path to the .docx file.
 * @returns {Promise<Array<{id: string, required: boolean, text: string}>>}
 */
async function parseQuestions(docxPath) {
  const result = await mammoth.extractRawText({ path: docxPath });
  const lines = result.value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const questions = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(QUESTION_ID_RE);
    if (!match) continue;

    const id = match[1];
    const required = match[2] === 'Required';

    // Find the next non-meta line as the question text
    let text = '';
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const next = lines[j];
      if (
        next.startsWith('Interviewer instruction') ||
        next.startsWith('Enumerator') ||
        next.startsWith('☐') ||
        QUESTION_ID_RE.test(next)
      ) {
        break;
      }
      text = next;
      break;
    }

    questions.push({ id, required, text });
  }

  return questions;
}

module.exports = { parseQuestions };

