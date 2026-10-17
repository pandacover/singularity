/**
 * Whether a prompt asks for a change. In a conversation most prompts don't:
 * the person approves a plan ("yes", "perfect, please do"), asks to commit
 * ("commit and open a PR"), points the agent at a file to read ("please read
 * @HANDOFF.md") or asks how things stand ("what's our benchmark numbers so
 * far?"). What was asked for is in an earlier prompt, or only in the commit
 * the agent wrote. A record keeps the prompt that asked as its task
 * (records/Build.ts), and the hook hands a change over only for a prompt that
 * asks (scripts/Hook.ts): one that doesn't would match another session's
 * "yes" word for word.
 *
 * A prompt asks when, without the words every prompt has (stopwords, approval,
 * committing, pointing at something to read), at least `MIN_WORDS` distinct
 * words of its own are left, and it isn't a question about how things stand.
 * A prompt that asks to commit, push or merge closes the task before it: it
 * asks only when it says more than that (`MIN_WORDS_CLOSING`), as a task
 * prompt that ends with "commit when you're done" does.
 *
 * Pure: no model call, the same answer every time.
 */

/** Words that say nothing of what a prompt asks for. */
const FILLER = new Set(
  (
    // English function words
    "a an and are as at be been being but by can could did do does doing done for from had has have having he her " +
    "here him his how i if in into is it its just me mine my no nor not now of off on once only onto or our ours out " +
    "over own she should so some such than that the their them then there these they this those through to too under " +
    "until up us very was we were what when where which while who whom whose why will with would you your yours " +
    "about above after again against all also although any because before below between both cannot down during each " +
    "either else even ever every few further hence however least less let lets may might more most much must neither " +
    "never nothing once other others otherwise perhaps rather really same shall since still though thus till unless " +
    "upon whether within without yet already always maybe quite actually well like want wants wanted need needs " +
    "needed get got make made sure way thing things lot bit kind sort able going gonna wanna " +
    // approving and moving on
    "yes yeah yep yup okay alright sure perfect great good nice cool fine right correct agreed agree exactly awesome " +
    "excellent thanks thank lgtm sounds sound looks look seems seem ahead continue continuing proceed carry keep " +
    "please hmm next later soon first start started go goes went moving move discuss suggested order " +
    // committing and its kin
    "commit commits committed committing push pushed pushing merge merged merging pull request requests open raise " +
    "create branch branches main master rebase squash changes current work working everything stuff finish finished " +
    // pointing at something to read, or at the plan
    "read take tell explain step steps series plan plans think thoughts wdyt context session sessions " +
    "summary summarize handoff readme claude agents"
  ).split(" ")
)

/** Words of its own a prompt needs to ask for something. */
export const MIN_WORDS = 4
/** Words of its own a prompt that asks to commit, push or merge needs to ask for more than that. */
export const MIN_WORDS_CLOSING = 6

/** Committing, pushing, merging, a pull request. */
const CLOSING = /\b(commit|push|merge|pull request|PR|PRs)\b/i

/** A question about how things stand: what, how, do you think… ("how about we…" suggests a change). */
const QUESTION = /^(?:(?:do|does|did) (?:you|we|it)\b|(?:is|are|was|were) (?:it|there|this|that|we|they)\b|what|what's|whats|how(?!\s+about\b)|why|where|which|who|when|wdyt|wdym|any thoughts|thoughts)/i
/** A question with more words of its own than this, and no question mark at its end, may be a request put as one ("how about we add…"). */
const MAX_QUESTION_WORDS = 7

/**
 * A prompt that says to change nothing: one that shows the agent around ("have
 * a look around first; don't change anything yet"), however many words it
 * has. Not "…but don't change anything else", a request's limit.
 */
const NO_CHANGE = /\b(?:don'?t|do not)\s+(?:change|edit|touch|modify)\s+anything(?!\s+else)\b|\b(?:don'?t|do not)\s+make\s+any\s+changes\b|\bchange nothing\b/i

/** The distinct words of a prompt that say what it's about. */
export const ownTerms = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !FILLER.has(w)))

/** Whether a prompt (as the person wrote it: traces/Prompts.ts `personText`) asks for a change. */
export const isRequest = (text: string): boolean => {
  const t = text.trim()
  if (t === "" || NO_CHANGE.test(t.replace(/[’‘]/g, "'"))) return false
  const n = ownTerms(t).size
  if (QUESTION.test(t) && (/\?\s*$/.test(t) || n <= MAX_QUESTION_WORDS)) return false
  return n >= (CLOSING.test(t) ? MIN_WORDS_CLOSING : MIN_WORDS)
}
