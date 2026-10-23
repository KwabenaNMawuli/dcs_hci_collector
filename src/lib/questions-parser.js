/**
 * questions-parser.js
 * Parses a .docx questionnaire (Akan or Ewe) and extracts question IDs, prompt text, and options.
 * Question lines are identified by a leading code like C1, P6, R1a, M12, etc.
 */

const mammoth = require('mammoth');

const QUESTION_HEADER_RE = /^([A-Z][A-Z0-9]?[0-9]+[a-z]?)\s+(Ehiã|Lɔlɔ̃nu|Required|Optional|Disability|Ame siwo)(.*)/;

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
    const match = lines[i].match(QUESTION_HEADER_RE);
    if (!match) continue;

    const id = match[1];
    const statusWord = match[2];
    const required =
      statusWord === 'Required' ||
      statusWord === 'Ehiã' ||
      statusWord === 'Disability' ||
      statusWord === 'Ame siwo';

    let text = '';
    const options = [];

    // For R1a in both questionnaires, prompt begins on header line
    if (statusWord === 'Disability' || statusWord === 'Ame siwo') {
      text = (statusWord + match[3]).trim();
    }

    // Collect subsequent lines until the next question header
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (QUESTION_HEADER_RE.test(line)) break;

      if (
        !text &&
        !line.startsWith('Interviewer instruction') &&
        !line.startsWith('Enumerator') &&
        !line.startsWith('Mɔfiame') &&
        !line.startsWith('Nyabiasea') &&
        !line.startsWith('☐') &&
        !line.startsWith('#') &&
        !line.startsWith('Ŋkɔ gbãtɔ') &&
        !line.startsWith('First name')
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
