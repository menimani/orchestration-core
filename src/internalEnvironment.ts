export const WINDOWS_PROCESS_ROOT_PID_ENV = 'ORCHESTRATION_WINDOWS_PROCESS_ROOT_PID'
export const LOOP_STARTUP_RESULT_FILE_ENV = 'ORCHESTRATION_LOOP_STARTUP_RESULT_FILE'
export const LOOP_RESTART_READY_FILE_ENV = 'ORCHESTRATION_LOOP_RESTART_READY_FILE'
export const LOOP_RESTART_PREDECESSOR_PID_ENV = 'ORCHESTRATION_LOOP_RESTART_PREDECESSOR_PID'

const PRIVATE_PROJECT_COMMAND_ENV = new Set([
  WINDOWS_PROCESS_ROOT_PID_ENV,
  LOOP_STARTUP_RESULT_FILE_ENV,
  LOOP_RESTART_READY_FILE_ENV,
  LOOP_RESTART_PREDECESSOR_PID_ENV,
])

/** Preserve the operator's environment while withholding core-owned process metadata. */
export function projectCommandEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !PRIVATE_PROJECT_COMMAND_ENV.has(
      platform === 'win32' ? name.toUpperCase() : name,
    )),
  )
}
