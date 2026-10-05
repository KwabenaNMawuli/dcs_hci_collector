/**
 * questions-parser.js
 * Parses a .docx questionnaire and extracts question IDs, prompt text, and options.
 * Question lines are identified by a leading code like C1, P6, R1a, M12, etc.
 */

const mammoth = require('mammoth');

const QUESTION_ID_RE = /^([A-Z][A-Z0-9]?[0-9]+[a-z]?)\s+(Required|Optional)(.*)/;

/**
 * Parse questions from a .docx file.
 * @param {string} docxPath - Absolute path to the .docx file.
 * @returns {Promise<Array<{id: string, required: boolean, text: string, options: string[]}>>}
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

    let text = '';
    const options = [];

    // Collect subsequent lines until the next question header
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (QUESTION_ID_RE.test(line)) break;

      if (
        !text &&
        !line.startsWith('Interviewer instruction') &&
        !line.startsWith('Enumerator') &&
        !line.startsWith('☐')
      ) {
        text = line;
      }

      if (line.startsWith('☐')) {
        options.push(line.replace(/^☐\s*/, ''));
      }
    }

    questions.push({ id, required, text, options });
  }

  return questions;
}

module.exports = { parseQuestions };
