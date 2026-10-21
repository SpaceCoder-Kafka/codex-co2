#!/bin/sh
# This script is selected only by the prototype's dedicated authorized_keys entries.
# It is an environment adapter for trusted peers, not a restricted account sandbox.
set -eu
config=$1
mode=$2
shift 2
. "$config"
export CODEX_HOME CODEX_INSTALL_DIR
CODEX_SSH_SKIP_APP_SERVER_BOOT=true
SHELL="$CODEX_COOP_SHELL"
PATH="$CODEX_INSTALL_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CODEX_SSH_SKIP_APP_SERVER_BOOT SHELL PATH

case "$mode" in
  entry)
    if [ -z "${SSH_ORIGINAL_COMMAND:-}" ]; then
      echo 'This test key requires a Codex SSH command; interactive login is disabled.' >&2
      exit 64
    fi
    exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"
    ;;
  shell)
    # Desktop deliberately launches a login shell. Avoid loading the account's
    # profiles, which could redirect PATH/CODEX_HOME or emit bytes into the proxy.
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -l|-i|-il|-li) shift ;;
        -c)
          shift
          [ "$#" -gt 0 ] || exit 64
          command=$1
          shift
          exec /bin/sh -c "$command" "$@"
          ;;
        *) echo 'Unsupported test-shell invocation.' >&2; exit 64 ;;
      esac
    done
    echo 'Interactive test shells are disabled.' >&2
    exit 64
    ;;
  codex)
    case "${1:-}" in
      --version|-V)
        [ "$#" -eq 1 ] || exit 64
        exec "$CODEX_COOP_CLI" --version
        ;;
      app-server)
        if [ "$#" -eq 2 ] && [ "$2" = proxy ]; then
          exec "$CODEX_COOP_CLI" app-server proxy --sock "$CODEX_COOP_SOCKET"
        fi
        ;;
    esac
    echo 'The test connection only supports codex --version and app-server proxy; start the shared backend with the local prototype CLI.' >&2
    exit 64
    ;;
  deny-pkill)
    # Desktop's restart/update path uses a broad Codex process-name match. A
    # shared execution host may also own unrelated Codex backends.
    echo 'Remote pkill is disabled for this shared connection. Stop the dedicated runtime locally with npm stop in the prototype directory.' >&2
    exit 64
    ;;
  *) echo 'Unknown SSH adapter mode.' >&2; exit 64 ;;
esac
