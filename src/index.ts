import { connect } from "./gateway";

export { RedisDO } from "./database/object";
export default { connect } satisfies ExportedHandler<Env>;
