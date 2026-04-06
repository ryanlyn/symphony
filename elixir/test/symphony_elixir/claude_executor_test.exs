defmodule SymphonyElixir.ClaudeExecutorTest do
  use SymphonyElixir.TestSupport
  import Bitwise, only: [&&&: 2]

  alias SymphonyElixir.Claude.{Executor, Mcp}

  test "mcp prepare writes workspace-local config and dependency-free sidecar" do
    test_root = Path.join(System.tmp_dir!(), "symphony-claude-mcp-#{System.unique_integer([:positive])}")

    try do
      workspace = create_git_workspace!(test_root, "MT-CLAUDE-MCP").workspace

      assert {:ok, %{config_path: config_path, sidecar_path: sidecar_path}} = Mcp.prepare(workspace)
      assert File.exists?(config_path)
      assert File.exists?(sidecar_path)
      assert (File.stat!(sidecar_path).mode &&& 0o111) != 0

      config = Jason.decode!(File.read!(config_path))
      assert get_in(config, ["mcpServers", "symphony_linear", "type"]) == "stdio"
      assert get_in(config, ["mcpServers", "symphony_linear", "args"]) == [sidecar_path]
      assert get_in(config, ["mcpServers", "symphony_linear", "env"]) == nil
      refute File.read!(config_path) =~ "token"
      assert File.read!(sidecar_path) =~ "linear_graphql"
      assert File.read!(sidecar_path) =~ "protocolVersion"
    after
      File.rm_rf(test_root)
    end
  end

  test "claude executor passes linear auth via environment instead of persisting it in mcp config" do
    test_root = Path.join(System.tmp_dir!(), "symphony-claude-env-#{System.unique_integer([:positive])}")

    try do
      %{workspace_root: workspace_root, workspace: workspace} =
        create_git_workspace!(test_root, "MT-CLAUDE-ENV")

      trace_file = Path.join(test_root, "env.trace")
      fake_claude = Path.join(test_root, "fake-claude")

      File.write!(
        fake_claude,
        """
        #!/bin/sh
        trace_file="#{trace_file}"

        printf 'ENV_API_KEY:%s\\n' "$SYMPHONY_LINEAR_API_KEY" >> "$trace_file"
        printf 'ENV_ENDPOINT:%s\\n' "$SYMPHONY_LINEAR_ENDPOINT" >> "$trace_file"
        printf 'ARGV:%s\\n' "$*" >> "$trace_file"

        while IFS= read -r _line; do
          printf '%s\\n' '{"type":"system","subtype":"init","session_id":"session-env"}'
          printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"session-env","usage":{"inputTokens":1,"outputTokens":1}}'
        done
        """
      )

      File.chmod!(fake_claude, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "claude",
        claude_command: fake_claude,
        tracker_api_token: "plaintext-linear-secret",
        tracker_endpoint: "https://linear.example/graphql"
      )

      issue = %Issue{
        id: "issue-claude-env",
        identifier: "MT-CLAUDE-ENV",
        title: "Claude env",
        description: "Verify Linear MCP auth is injected via environment",
        state: "In Progress",
        url: "https://example.org/issues/MT-CLAUDE-ENV",
        labels: []
      }

      assert {:ok, session} = Executor.start_session(workspace)
      assert {:ok, _session, _result} = Executor.run_turn(session, "Run once", issue)

      trace = File.read!(trace_file)
      assert trace =~ "ENV_API_KEY:plaintext-linear-secret"
      assert trace =~ "ENV_ENDPOINT:https://linear.example/graphql"

      config_contents = File.read!(session.config_path)
      refute config_contents =~ "plaintext-linear-secret"
      refute config_contents =~ "SYMPHONY_LINEAR_API_KEY"
    after
      File.rm_rf(test_root)
    end
  end

  test "claude executor closes a started port when later startup work fails" do
    test_root =
      Path.join(System.tmp_dir!(), "symphony-claude-startup-cleanup-#{System.unique_integer([:positive])}")

    try do
      %{workspace_root: workspace_root, workspace: workspace} =
        create_git_workspace!(test_root, "MT-CLAUDE-CLEANUP")

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "claude"
      )

      parent = self()

      assert {:error, :synthetic_startup_failure} =
               Executor.start_session(workspace,
                 start_port_fn: fn _session, _issue ->
                   port = open_idle_port!()
                   send(parent, {:started_port, port})
                   {:ok, port, %{}}
                 end,
                 complete_start_session_fn: fn _base_session, _port, _metadata ->
                   {:error, :synthetic_startup_failure}
                 end
               )

      assert_receive {:started_port, port}
      assert_port_closed(port)
    after
      File.rm_rf(test_root)
    end
  end

  test "claude executor keeps one persistent worker across multiple turns" do
    test_root = Path.join(System.tmp_dir!(), "symphony-claude-executor-#{System.unique_integer([:positive])}")

    try do
      %{workspace_root: workspace_root, workspace: workspace} = create_git_workspace!(test_root, "MT-CLAUDE")
      trace_file = Path.join(test_root, "claude.trace")
      fake_claude = Path.join(test_root, "fake-claude")

      File.write!(
        fake_claude,
        fake_persistent_claude_script(trace_file, "session-tool", """
        case "$count" in
          1)
            printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__symphony_linear__linear_graphql"}],"usage":{"inputTokens":4,"outputTokens":2}},"session_id":"session-tool"}'
            printf '%s\\n' '{"type":"user","tool_use_result":{"tool_name":"mcp__symphony_linear__linear_graphql","stdout":"viewer-1"},"session_id":"session-tool"}'
            printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"session-tool","usage":{"inputTokens":12,"cacheCreationInputTokens":3,"cacheReadInputTokens":4,"outputTokens":6}}'
            ;;
          2)
            printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"second turn"}],"usage":{"inputTokens":2,"outputTokens":1}},"session_id":"session-tool"}'
            printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"Done again.","session_id":"session-tool","usage":{"inputTokens":4,"cacheCreationInputTokens":1,"cacheReadInputTokens":1,"outputTokens":2}}'
            ;;
        esac
        """)
      )

      File.chmod!(fake_claude, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "claude",
        claude_command: fake_claude,
        claude_model: "claude-sonnet-4-6",
        claude_permission_mode: "dontAsk",
        claude_strict_mcp_config: true
      )

      issue = %Issue{
        id: "issue-claude",
        identifier: "MT-CLAUDE",
        title: "Claude executor",
        description: "Exercise the claude executor executor",
        state: "In Progress",
        url: "https://example.org/issues/MT-CLAUDE",
        labels: []
      }

      assert {:ok, session} =
               Executor.start_session(workspace,
                 issue: issue,
                 resume_metadata: %{resume_id: "session-prev", session_id: "session-prev"}
               )

      log =
        capture_log(fn ->
          assert {:ok, updated_session, _result} =
                   Executor.run_turn(session, "Use the MCP tool and finish", issue, on_message: &send(self(), {:claude_update, &1}))

          send(self(), {:first_turn_session, updated_session})
        end)

      assert log =~ "Claude turn started for issue_id=issue-claude issue_identifier=MT-CLAUDE"
      assert log =~ "Claude turn completed for issue_id=issue-claude issue_identifier=MT-CLAUDE session_id=session-tool"
      assert_receive {:first_turn_session, session}

      assert session.resume_id == "session-tool"
      assert session.session_id == "session-tool"

      assert_receive {:claude_update,
                      %{
                        event: :session_started,
                        session_id: "session-tool",
                        issue_id: "issue-claude",
                        issue_identifier: "MT-CLAUDE",
                        issue_title: "Claude executor"
                      }}

      assert_receive {:claude_update,
                      %{
                        event: :turn_started,
                        issue_id: "issue-claude",
                        issue_identifier: "MT-CLAUDE",
                        issue_title: "Claude executor"
                      }}

      assert_receive {:claude_update, %{event: :tool_use_requested}}
      assert_receive {:claude_update, %{event: :tool_result}}

      expected_usage = %{input_tokens: 19, output_tokens: 6, total_tokens: 25}
      assert_receive {:claude_update, %{event: :turn_completed, usage: ^expected_usage}}, 1_000

      first_turn_pid =
        receive do
          {:claude_update, %{executor_pid: executor_pid}} when is_binary(executor_pid) -> executor_pid
        after
          0 -> session.metadata.executor_pid
        end

      assert {:ok, session, _result} =
               Executor.run_turn(session, "Second turn", issue, on_message: &send(self(), {:claude_update, &1}))

      assert session.resume_id == "session-tool"
      assert session.session_id == "session-tool"
      assert_receive {:claude_update, %{event: :turn_started, executor_pid: ^first_turn_pid}}
      assert_receive {:claude_update, %{event: :assistant_message, executor_pid: ^first_turn_pid}}
      assert_receive {:claude_update, %{event: :turn_completed, executor_pid: ^first_turn_pid}}

      trace = File.read!(trace_file)
      assert trace =~ "--print"
      assert trace =~ "-n MT-CLAUDE: Claude executor"
      assert trace =~ "--resume session-prev"
      assert trace =~ "--allowedTools Bash,Edit,Write,mcp__symphony_linear__linear_graphql"
      assert trace =~ "--mcp-config "
      assert trace =~ "--strict-mcp-config"
      assert trace =~ "--model claude-sonnet-4-6"
      assert length(Regex.scan(~r/^ARGV:/m, trace)) == 1

      assert get_in(Jason.decode!(File.read!(trace_file <> ".stdin.1")), ["message", "content"]) ==
               "Use the MCP tool and finish"

      assert get_in(Jason.decode!(File.read!(trace_file <> ".stdin.2")), ["message", "content"]) ==
               "Second turn"
    after
      File.rm_rf(test_root)
    end
  end

  test "claude executor accepts init emitted only after the first streamed turn starts" do
    test_root =
      Path.join(System.tmp_dir!(), "symphony-claude-late-init-#{System.unique_integer([:positive])}")

    try do
      %{workspace_root: workspace_root, workspace: workspace} = create_git_workspace!(test_root, "MT-CLAUDE-LATE-INIT")
      trace_file = Path.join(test_root, "late-init.trace")
      fake_claude = Path.join(test_root, "fake-claude")

      File.write!(
        fake_claude,
        """
        #!/bin/sh
        trace_file="#{trace_file}"

        case "$1" in
          --help)
            cat <<'EOF'
        Usage: claude [options]
          -p, --print
          --verbose
          --output-format <format>
          --input-format <format>
          --resume [value]
          --permission-mode <mode>
          --model <model>
          --mcp-config <configs...>
          --strict-mcp-config
        EOF
            exit 0
            ;;
          --version)
            printf '%s\\n' '2.1.88 (Claude Code)'
            exit 0
            ;;
        esac

        printf 'ARGV:%s\\n' "$*" >> "$trace_file"
        count=0

        while IFS= read -r line; do
          count=$((count + 1))
          printf '%s' "$line" > "${trace_file}.stdin.$count"

          if [ "$count" -eq 1 ]; then
            printf '%s\\n' '{"type":"system","subtype":"init","session_id":"session-late"}'
          fi

          printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"late init ok","session_id":"session-late","usage":{"inputTokens":3,"outputTokens":1}}'
        done
        """
      )

      File.chmod!(fake_claude, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "claude",
        claude_command: fake_claude
      )

      issue = %Issue{
        id: "issue-claude-late-init",
        identifier: "MT-CLAUDE-LATE-INIT",
        title: "Claude late init",
        description: "Exercise delayed system init delivery",
        state: "In Progress",
        url: "https://example.org/issues/MT-CLAUDE-LATE-INIT",
        labels: []
      }

      assert {:ok, session} = Executor.start_session(workspace)
      assert session.session_id == nil
      assert session.resume_id == nil

      assert {:ok, session, _result} =
               Executor.run_turn(session, "First streamed turn", issue, on_message: &send(self(), {:claude_update, &1}))

      assert session.session_id == "session-late"
      assert session.resume_id == "session-late"
      assert_receive {:claude_update, %{event: :turn_started, session_id: nil}}
      assert_receive {:claude_update, %{event: :session_started, session_id: "session-late"}}
      assert_receive {:claude_update, %{event: :turn_completed, session_id: "session-late"}}
      refute Regex.scan(~r/^ARGV:/m, File.read!(trace_file)) == []
    after
      File.rm_rf(test_root)
    end
  end

  test "claude executor resets turn timeout after streamed output" do
    test_root =
      Path.join(System.tmp_dir!(), "symphony-claude-timeout-reset-#{System.unique_integer([:positive])}")

    try do
      %{workspace_root: workspace_root, workspace: workspace} = create_git_workspace!(test_root, "MT-CLAUDE-TIMEOUT")
      fake_claude = Path.join(test_root, "fake-claude")

      File.write!(
        fake_claude,
        fake_persistent_claude_script(Path.join(test_root, "timeout.trace"), "session-timeout", """
        sleep 0.45
        printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"tick-1"}]}}'
        sleep 0.45
        printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"tick-2"}]}}'
        sleep 0.45
        printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"tick-3"}]}}'
        sleep 0.45
        printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"session-timeout","usage":{"inputTokens":1,"outputTokens":1}}'
        """)
      )

      File.chmod!(fake_claude, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "claude",
        claude_command: fake_claude,
        claude_turn_timeout_ms: 1_000
      )

      issue = %Issue{
        id: "issue-claude-timeout",
        identifier: "MT-CLAUDE-TIMEOUT",
        title: "Claude timeout reset",
        description: "Ensure timeout resets while output keeps streaming",
        state: "In Progress",
        url: "https://example.org/issues/MT-CLAUDE-TIMEOUT",
        labels: []
      }

      assert {:ok, session} = Executor.start_session(workspace)

      assert {:ok, _updated_session, %{"result" => "done"}} =
               Executor.run_turn(session, "Wait through streamed output", issue, on_message: &send(self(), {:claude_update, &1}))

      assert_receive {:claude_update, %{event: :session_started, session_id: "session-timeout"}}
      assert_receive {:claude_update, %{event: :turn_started}}

      assert_receive {:claude_update, %{event: :assistant_message, payload: %{"message" => %{"content" => [%{"text" => "tick-1"}]}}}}

      assert_receive {:claude_update, %{event: :assistant_message, payload: %{"message" => %{"content" => [%{"text" => "tick-2"}]}}}}

      assert_receive {:claude_update, %{event: :assistant_message, payload: %{"message" => %{"content" => [%{"text" => "tick-3"}]}}}}

      assert_receive {:claude_update, %{event: :turn_completed}}
    after
      File.rm_rf(test_root)
    end
  end

  test "claude executor reports malformed output before permission-denied failures" do
    test_root = Path.join(System.tmp_dir!(), "symphony-claude-denied-#{System.unique_integer([:positive])}")

    try do
      %{workspace_root: workspace_root, workspace: workspace} = create_git_workspace!(test_root, "MT-CLAUDE-DENIED")
      fake_claude = Path.join(test_root, "fake-claude")

      File.write!(
        fake_claude,
        fake_persistent_claude_script(Path.join(test_root, "denied.trace"), "session-denied", """
        printf '%s\\n' 'not-json'
        printf '%s\\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"session-denied","permission_denials":[{"tool_name":"Bash"}],"errors":["Permission denied"],"usage":{"inputTokens":1,"outputTokens":0}}'
        """)
      )

      File.chmod!(fake_claude, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "claude",
        claude_command: fake_claude
      )

      issue = %Issue{
        id: "issue-claude-denied",
        identifier: "MT-CLAUDE-DENIED",
        title: "Claude denied",
        description: "Exercise malformed + permission denied parsing",
        state: "In Progress",
        url: "https://example.org/issues/MT-CLAUDE-DENIED",
        labels: []
      }

      assert {:ok, session} = Executor.start_session(workspace)

      assert {:error, {:claude_turn_failed, %{"permission_denials" => [_ | _]}}} =
               Executor.run_turn(session, "Do the forbidden thing", issue, on_message: &send(self(), {:claude_update, &1}))

      assert_receive {:claude_update, %{event: :malformed}}
      assert_receive {:claude_update, %{event: :session_started, session_id: "session-denied"}}
      assert_receive {:claude_update, %{event: :turn_started}}
      assert_receive {:claude_update, %{event: :permission_denied}}
    after
      File.rm_rf(test_root)
    end
  end

  test "claude executor rejects the workspace root and paths outside workspace root" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-claude-executor-cwd-guard-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")
      outside_workspace = Path.join(test_root, "outside")

      File.mkdir_p!(workspace_root)
      File.mkdir_p!(outside_workspace)

      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

      assert {:error, {:invalid_workspace_cwd, :workspace_root, _path}} =
               Executor.start_session(workspace_root)

      assert {:error, {:invalid_workspace_cwd, :outside_workspace_root, _path, _root}} =
               Executor.start_session(outside_workspace)
    after
      File.rm_rf(test_root)
    end
  end

  test "claude executor rejects symlink escape cwd paths under the workspace root" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-claude-executor-symlink-cwd-guard-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")
      outside_workspace = Path.join(test_root, "outside")
      symlink_workspace = Path.join(workspace_root, "MT-CLAUDE-SYM")

      File.mkdir_p!(workspace_root)
      File.mkdir_p!(outside_workspace)
      File.ln_s!(outside_workspace, symlink_workspace)

      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

      assert {:error, {:invalid_workspace_cwd, :symlink_escape, ^symlink_workspace, _root}} =
               Executor.start_session(symlink_workspace)
    after
      File.rm_rf(test_root)
    end
  end

  test "claude executor rejects invalid remote workspace strings before launch" do
    assert {:error, {:invalid_workspace_cwd, :empty_remote_workspace, "worker-1"}} =
             Executor.start_session("   ", worker_host: "worker-1")

    assert {:error, {:invalid_workspace_cwd, :invalid_remote_workspace, "worker-1", "bad\npath"}} =
             Executor.start_session("bad\npath", worker_host: "worker-1")
  end

  test "claude executor surfaces unreadable local workspace paths before launch" do
    workspace_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-claude-executor-unreadable-cwd-guard-#{System.unique_integer([:positive])}"
      )

    invalid_segment = String.duplicate("a", 300)
    unreadable_workspace = Path.join(System.tmp_dir!(), invalid_segment)
    expanded_workspace = Path.expand(unreadable_workspace)

    try do
      File.mkdir_p!(workspace_root)
      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

      assert {:error, {:invalid_workspace_cwd, :path_unreadable, ^expanded_workspace, :enametoolong}} =
               Executor.start_session(unreadable_workspace)
    after
      File.rm_rf(workspace_root)
    end
  end

  test "claude executor fails clearly on unsupported control protocol messages" do
    test_root =
      Path.join(System.tmp_dir!(), "symphony-claude-control-request-#{System.unique_integer([:positive])}")

    try do
      %{workspace_root: workspace_root, workspace: workspace} = create_git_workspace!(test_root, "MT-CLAUDE-CONTROL")
      fake_claude = Path.join(test_root, "fake-claude")

      File.write!(
        fake_claude,
        fake_persistent_claude_script(Path.join(test_root, "control.trace"), "session-control", """
        printf '%s\\n' '{"type":"control_request","request_id":"req-1","request":{"subtype":"mcp_status"}}'
        """)
      )

      File.chmod!(fake_claude, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "claude",
        claude_command: fake_claude
      )

      issue = %Issue{
        id: "issue-claude-control",
        identifier: "MT-CLAUDE-CONTROL",
        title: "Claude control request",
        description: "Exercise unsupported control protocol handling",
        state: "In Progress",
        url: "https://example.org/issues/MT-CLAUDE-CONTROL",
        labels: []
      }

      assert {:ok, session} = Executor.start_session(workspace)

      assert {:error, {:unsupported_control_protocol, %{"type" => "control_request"}}} =
               Executor.run_turn(session, "Trigger control", issue, on_message: &send(self(), {:claude_update, &1}))

      assert_receive {:claude_update, %{event: :session_started, session_id: "session-control"}}
      assert_receive {:claude_update, %{event: :turn_started}}
      assert_receive {:claude_update, %{event: :unsupported_control_protocol}}
    after
      File.rm_rf(test_root)
    end
  end

  defp fake_persistent_claude_script(trace_file, session_id, turn_body)
       when is_binary(trace_file) and is_binary(session_id) and is_binary(turn_body) do
    """
    #!/bin/sh
    trace_file="#{trace_file}"

    case "$1" in
      --help)
        cat <<'EOF'
    Usage: claude [options]
      -p, --print
      --verbose
      --output-format <format>
      --input-format <format>
      --resume [value]
      --permission-mode <mode>
      --model <model>
      --mcp-config <configs...>
      --strict-mcp-config
    EOF
        exit 0
        ;;
      --version)
        printf '%s\\n' '2.1.88 (Claude Code)'
        exit 0
        ;;
    esac

    printf 'ARGV:%s\\n' "$*" >> "$trace_file"
    count=0

    while IFS= read -r line; do
      count=$((count + 1))
      printf '%s' "$line" > "${trace_file}.stdin.$count"
      printf '%s\\n' '{"type":"system","subtype":"init","session_id":"#{session_id}"}'
      #{turn_body}
    done
    """
  end

  defp open_idle_port! do
    executable = System.find_executable("cat") || flunk("cat executable not found")

    Port.open({:spawn_executable, String.to_charlist(executable)}, [:binary, :exit_status])
  end

  defp assert_port_closed(port, attempts \\ 20)

  defp assert_port_closed(port, attempts) when attempts > 0 do
    case Port.info(port) do
      nil ->
        :ok

      _ ->
        Process.sleep(10)
        assert_port_closed(port, attempts - 1)
    end
  end

  defp assert_port_closed(_port, 0), do: flunk("port remained open")
end
