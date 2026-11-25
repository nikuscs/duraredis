import { connect } from "./gateway";
import { upgrade } from "./websocket";

export { RedisDO } from "./database/object";
export default { connect, fetch: upgrade } satisfies ExportedHandler<Env>;
