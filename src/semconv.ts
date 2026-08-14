/**
 * Wire vocabulary shared by the timeline projection and the exporter.
 *
 * `gen_ai.*` follows the OpenTelemetry GenAI semantic conventions;
 * `langfuse.*` is Langfuse's documented OTLP property mapping (traces and
 * observations); `dsh.*` is this package's own correlation vocabulary.
 *
 * @module dsh-langfuse/semconv
 */

// GenAI semantic conventions
export const ATTR_GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name'
export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model'
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens'
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens'
export const ATTR_GEN_AI_USAGE_CACHE_READ_TOKENS = 'gen_ai.usage.cache_read_tokens'
export const ATTR_GEN_AI_USAGE_REASONING_TOKENS = 'gen_ai.usage.reasoning_tokens'
export const ATTR_GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call.id'
export const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name'

// Langfuse OTLP property mapping
export const ATTR_LANGFUSE_SESSION_ID = 'langfuse.session.id'
export const ATTR_LANGFUSE_TRACE_NAME = 'langfuse.trace.name'
export const ATTR_LANGFUSE_TRACE_INPUT = 'langfuse.trace.input'
export const ATTR_LANGFUSE_OBSERVATION_TYPE = 'langfuse.observation.type'
export const ATTR_LANGFUSE_OBSERVATION_INPUT = 'langfuse.observation.input'
export const ATTR_LANGFUSE_OBSERVATION_OUTPUT = 'langfuse.observation.output'
export const ATTR_LANGFUSE_COMPLETION_START_TIME = 'langfuse.observation.completion_start_time'

// dsh-langfuse correlation vocabulary (deliberately distinct keys, so
// deployments can run different telemetry backends side by side on the
// same Langfuse project without attribute collisions).
export const ATTR_DSH_TURN = 'dsh.turn_idx'
export const ATTR_DSH_STEP = 'dsh.step_idx'
export const ATTR_DSH_EVENT_SEQ = 'dsh.event_seq'
export const ATTR_DSH_TURN_END_REASON = 'dsh.turn_end'
export const ATTR_DSH_FORCE_ENDED = 'dsh.forced_end'
export const ATTR_DSH_PARENT_SESSION = 'dsh.parent_session'
