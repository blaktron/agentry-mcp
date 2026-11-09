/**
 * Where each command of the `agentry` CLI stands for this server: the CLI
 * commands each tool runs, and the commands that stay in a terminal or the
 * desktop, each with the reason. A test holds the two against the CLI's
 * command tree (spec/cli-commands.txt), so a command the CLI gains is either
 * given a tool or named here before the server ships.
 */

/** The CLI commands each tool runs; an empty list runs none. */
export const TOOL_COMMANDS: Record<string, readonly string[]> = {
  agentry_whoami: ["whoami"],
  agentry_builtins: ["builtins"],
  agentry_doctor: ["doctor", "runhost doctor"],
  agentry_setup: ["setup"],
  agentry_search: ["search"],
  agentry_info: ["info"],
  agentry_verify: ["verify"],
  agentry_install: ["install"],
  agentry_uninstall: ["uninstall"],
  agentry_list_installed: ["list"],
  agentry_run: ["run"],
  // These two read the run record this server started and signal its process.
  agentry_run_status: [],
  agentry_run_cancel: [],
  agentry_deliver: ["deliver"],
  agentry_destinations_list: ["destinations list"],
  agentry_session_start: ["run"],
  // A session's turns and files go into the chat the start opened.
  agentry_session_send: [],
  agentry_session_add: [],
  agentry_session_close: [],
  agentry_validate: ["validate"],
  agentry_draft: ["draft"],
  agentry_review: ["review"],
  agentry_knowledge_list: ["knowledge list"],
  agentry_knowledge_build: ["knowledge create", "knowledge add"],
  agentry_voice_status: ["voice status"],
  agentry_voice_show: ["voice show"],
  agentry_voice_build: ["voice create", "voice improve", "voice edit"],
  agentry_report_design_show: ["report-design show"],
  agentry_report_design_list: ["report-design list"],
  agentry_report_design_build: ["report-design design", "report-design cover"],
  agentry_connections_list: ["connections list"],
  agentry_model_signins_list: ["model-signins list"],
  agentry_models_list: ["models list"],
  agentry_schedule_list: ["schedule list", "runhost schedules"],
  agentry_schedule_show: ["schedule show"],
  agentry_schedule_pause: ["schedule pause", "schedule resume", "schedule show"],
  agentry_runhost_list: ["runhost list"],
  agentry_agent_list: ["agent list"],
  agentry_agent_show: ["agent show"],
  agentry_agent_install: ["agent install", "info"],
  agentry_agent_uninstall: ["agent uninstall"],
  agentry_agent_start: ["agent start"],
  agentry_agent_stop: ["agent stop"],
  agentry_agent_send: ["agent attach"],
  agentry_agent_tasks: ["agent tasks"],
  agentry_agent_compact: ["agent compact"],
  agentry_agent_grant: ["agent grant"],
};

const SIGN_IN =
  "signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model";
const PUBLISH =
  "publishes to the registry or changes what the person's account holds there; a person decides that in a terminal or on the site";
const TERMINAL_UI = "an interactive terminal interface, not a command a program reads";
const SETUP_IMAGE =
  "fetches or builds a runner image; agentry_run and agentry_setup do it when a run needs it";
const LOCAL_FOLDERS =
  "acts on this computer's folders and desktop (lists the runs made from here, or opens a folder in the file manager)";
const SCHEDULE_EDIT =
  "makes, changes or removes a schedule, which runs a QuickAgent later with nobody asked; the person does it in a terminal or the desktop";
const RUNHOST_ADMIN =
  "sets up, pairs, updates or removes a remote runhost, which takes the person's own server and sign-in";
const RUNHOST_JOBS =
  "follows or collects a job on a remote runhost; agentry_run with `on` starts and follows its own runs";
const AGENT_SETUP =
  "configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds";
const LOCAL_STORE =
  "deletes, downloads, exports or imports a kept pack, voice, design or memory on this computer; the person does it in a terminal or the desktop";
const ORG_POLICY =
  "reads or refreshes what the person's organization manages; the desktop and the terminal show it where the person can act on it";
const PROFILES = "changes the stored MCP profiles, which hold the keys a QuickAgent's servers use";
const SCAFFOLD =
  "writes a new workspace in a folder of the person's; agentry_draft drafts one from a description";
const ACP =
  "is the Agent Client Protocol server itself, which a host starts directly instead of this one";
const RUN_DEFAULTS =
  "changes what every later run takes or where its results go, which the person decides once in a terminal or the desktop";
const SCHEDULE_NOW =
  "runs a schedule's QuickAgent now on the consent given when the schedule was made; agentry_run asks for a run's consent itself";
const SAVED_MODELS =
  "changes the saved models every later run, schedule and agent may take, or checks one by asking its provider (a Claude subscription's check spends one message), which the person decides in a terminal or the desktop";
const PROVIDERS_LIST =
  "lists the providers on this computer, each with its credential's kind; agentry_models_list names each saved model's provider";
const SIGNED_OUT =
  "checks this computer's keychain and login session for running schedules signed out, which the person sets up in a terminal";

/** The commands that stay in a terminal or the desktop, and why. */
export const TERMINAL_ONLY: Record<string, string> = {
  login: SIGN_IN,
  logout: SIGN_IN,
  connect: SIGN_IN,
  "connections remove": SIGN_IN,
  "connections client list": SIGN_IN,
  "connections client set": SIGN_IN,
  "connections client remove": SIGN_IN,
  "model-signins add": SIGN_IN,
  "model-signins remove": SIGN_IN,
  "providers add": SIGN_IN,
  "providers remove": SIGN_IN,
  "providers list": PROVIDERS_LIST,
  "models add": SAVED_MODELS,
  "models edit": SAVED_MODELS,
  "models remove": SAVED_MODELS,
  "models default": SAVED_MODELS,
  "models check": SAVED_MODELS,
  "runhost model": SIGN_IN,
  "runhost store": SIGN_IN,
  publish: PUBLISH,
  yank: PUBLISH,
  fork: PUBLISH,
  "builtins publish": PUBLISH,
  "knowledge upload": PUBLISH,
  "knowledge ship": PUBLISH,
  "knowledge download": LOCAL_STORE,
  "voice upload": PUBLISH,
  "voice download": LOCAL_STORE,
  "voice delete": LOCAL_STORE,
  "voice set": RUN_DEFAULTS,
  "voice attach": RUN_DEFAULTS,
  "report-design use": PUBLISH,
  "report-design delete": PUBLISH,
  "report-design import": PUBLISH,
  "report-design export": LOCAL_STORE,
  "knowledge delete": LOCAL_STORE,
  "knowledge export": LOCAL_STORE,
  "knowledge import": LOCAL_STORE,
  "agent memory export": LOCAL_STORE,
  init: SCAFFOLD,
  acp: ACP,
  "agent chat": TERMINAL_UI,
  "browser ensure": SETUP_IMAGE,
  "files ensure": SETUP_IMAGE,
  runs: LOCAL_FOLDERS,
  open: LOCAL_FOLDERS,
  "destinations add": SIGN_IN,
  "destinations default": RUN_DEFAULTS,
  "destinations remove": SIGN_IN,
  "schedule add": SCHEDULE_EDIT,
  "schedule edit": SCHEDULE_EDIT,
  "schedule remove": SCHEDULE_EDIT,
  "schedule run": SCHEDULE_NOW,
  "schedule reseal": SIGN_IN,
  "schedule sync": SCHEDULE_EDIT,
  "schedule check-signed-out": SIGNED_OUT,
  "runhost add": RUNHOST_ADMIN,
  "runhost pair": RUNHOST_ADMIN,
  "runhost unpair": RUNHOST_ADMIN,
  "runhost update": RUNHOST_ADMIN,
  "runhost remove": RUNHOST_ADMIN,
  "runhost set": RUNHOST_ADMIN,
  "runhost status": RUNHOST_JOBS,
  "runhost jobs": RUNHOST_JOBS,
  "runhost attach": RUNHOST_JOBS,
  "runhost collect": RUNHOST_JOBS,
  "runhost cancel": RUNHOST_JOBS,
  "agent configure": AGENT_SETUP,
  "agent enable": AGENT_SETUP,
  "agent disable": AGENT_SETUP,
  "agent reset": AGENT_SETUP,
  "agent secret list": AGENT_SETUP,
  "agent secret set": AGENT_SETUP,
  "agent secret remove": AGENT_SETUP,
  "agent skill list": AGENT_SETUP,
  "agent skill add": AGENT_SETUP,
  "agent skill remove": AGENT_SETUP,
  "agent messenger list": AGENT_SETUP,
  "agent messenger add": AGENT_SETUP,
  "agent messenger remove": AGENT_SETUP,
  "agent messenger pair": AGENT_SETUP,
  "agent messenger test": AGENT_SETUP,
  "agent messenger manifest": AGENT_SETUP,
  "managed show": ORG_POLICY,
  "managed refresh": ORG_POLICY,
  "profiles list": PROFILES,
  "profiles remove": PROFILES,
};
