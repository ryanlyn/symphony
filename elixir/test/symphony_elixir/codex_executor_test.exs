defmodule SymphonyElixir.CodexExecutorTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Codex.Executor

  test "codex executor falls back to configured runtime settings when none are injected" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-codex-executor-runtime-settings-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MONO-195")
      fake_codex = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-executor.trace")

      File.mkdir_p!(workspace)

      File.write!(
        fake_codex,
        """
        #!/bin/sh
        trace_file="#{trace_file}"

        while IFS= read -r line; do
          printf 'JSON:%s\\n' "$line" >> "$trace_file"

          case "$line" in
            *'"id":1'*)
              printf '%s\\n' '{"id":1,"result":{}}'
              ;;
            *'"id":2'*)
              printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-default-runtime-settings"}}}'
              ;;
          esac
        done
        """
      )

      File.chmod!(fake_codex, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{fake_codex} app-server"
      )

      assert {:ok, session} = Executor.start_session(workspace)
      assert session.resume_id == "thread-default-runtime-settings"
      assert session.app_session.command == "#{fake_codex} app-server"

      trace = File.read!(trace_file)
      assert trace =~ "\"method\":\"initialize\""
      assert trace =~ "\"method\":\"thread/start\""

      assert :ok = Executor.stop_session(session)
    after
      File.rm_rf(test_root)
    end
  end
end
