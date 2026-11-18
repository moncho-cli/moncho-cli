// Probe: resolve the model's context size from the configured provider and print
// the label with and without a CONTEXT_MAX_LENGTH override (task.md item 3).
import { resolveContextSize, formatContextLimit } from '../../utils/context-size.js';
import { BASE_URL, API_KEY, MODEL, describeModel } from '../../config/constants.js';

console.log('provider  :', describeModel().label);

const noOverride = await resolveContextSize({ configured: null, baseUrl: BASE_URL, model: MODEL, apiKey: API_KEY });
console.log('no config :', formatContextLimit(noOverride), '| source:', noOverride.source, '| max:', noOverride.maxTokens);

const withOverride = await resolveContextSize({ configured: 128000, baseUrl: BASE_URL, model: MODEL, apiKey: API_KEY });
console.log('override  :', formatContextLimit(withOverride), '| source:', withOverride.source, '| max:', withOverride.maxTokens);

if (noOverride.source === 'api' && noOverride.realTokens) {
  console.log('\nOK: real context length read from the API and shown next to the override');
} else {
  console.log('\nNote: no API total reported (offline or unknown model); fallback label used');
}
