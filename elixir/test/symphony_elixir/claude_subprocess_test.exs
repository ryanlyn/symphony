defmodule SymphonyElixir.ClaudeSubprocessTest do
  use SymphonyElixir.TestSupport
  import Bitwise, only: [&&&: 2]

  alias SymphonyElixir.Claude.{CapabilityProbe, Mcp, Subprocess}

  test "capability probe reads required flags from the cli help text" do
    runner = fn
      _command, ["--help"], _worker_host ->
        {:ok,
         """
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
         """}

      _command, ["--version"], _worker_host ->
        {:ok, "2.1.88 (Claude Code)\n"}
    end

    assert {:ok, capabilities} = CapabilityProbe.probe(command: "claude", runner: runner)
    assert capabilities.print == true
    assert capabilities.stream_json == true
    assert capabilities.verbose == true
    assert capabilities.input_format == true
    assert capabilities.resume == true
    assert capabilities.permission_mode == true
    assert capabilities.model == true
    assert capabilities.mcp_config == true
    assert capabilities.strict_mcp_config == true
    assert capabilities.version == "2.1.88 (Claude Code)"
  end

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
      assert File.read!(sidecar_path) =~ "linear_graphql"
      assert File.read!(sidecar_path) =~ "protocolVersion"
    after
      File.rm_rf(test_root)
    end
  end

  test "claude subprocess keeps one persistent worker across multiple turns" do
    test_root = Path.join(System.tmp_dir!(), "symphony-claude-subprocess-#{System.unique_integer([:positive])}")

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
        title: "Claude subprocess",
        description: "Exercise the claude subprocess executor",
        state: "In Progress",
        url: "https://example.org/issues/MT-CLAUDE",
        labels: []
      }

      assert {:ok, session} =
               Subprocess.start_session(workspace,
                 resume_metadata: %{resume_id: "session-prev", session_id: "session-prev"}
               )

      assert {:ok, session, _result} =
               Subprocess.run_turn(session, "Use the MCP tool and finish", issue, on_message: &send(self(), {:claude_update, &1}))

      assert session.resume_id == "session-tool"
      assert session.session_id == "session-tool"

      assert_receive {:claude_update, %{event: :session_started, session_id: "session-tool"}}
      assert_receive {:claude_update, %{event: :turn_started}}
      assert_receive {:claude_update, %{event: :tool_use_requested}}
      assert_receive {:claude_update, %{event: :tool_result}}

      assert_receive {:claude_update, %{event: :turn_completed, usage: %{input_tokens: 19, output_tokens: 6, total_tokens: 25}}},
                     1_000

      first_turn_pid =
        receive do
          {:claude_update, %{executor_pid: executor_pid}} when is_binary(executor_pid) -> executor_pid
        after
          0 -> session.metadata.executor_pid
        end

      assert {:ok, session, _result} =
               Subprocess.run_turn(session, "Second turn", issue, on_message: &send(self(), {:claude_update, &1}))

      assert session.resume_id == "session-tool"
      assert session.session_id == "session-tool"
      assert_receive {:claude_update, %{event: :turn_started, executor_pid: ^first_turn_pid}}
      assert_receive {:claude_update, %{event: :assistant_message, executor_pid: ^first_turn_pid}}
      assert_receive {:claude_update, %{event: :turn_completed, executor_pid: ^first_turn_pid}}

      trace = File.read!(trace_file)
      assert trace =~ "--print"
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

  test "claude subprocess accepts init emitted only after the first streamed turn starts" do
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

      assert {:ok, session} = Subprocess.start_session(workspace)
      assert session.session_id == nil
      assert session.resume_id == nil

      assert {:ok, session, _result} =
               Subprocess.run_turn(session, "First streamed turn", issue, on_message: &send(self(), {:claude_update, &1}))

      assert session.session_id == "session-late"
      assert session.resume_id == "session-late"
      assert_receive {:claude_update, %{event: :turn_started, session_id: nil}}
      assert_receive {:claude_update, %{event: :session_started, session_id: "session-late"}}
      assert_receive {:claude_update, %{event: :turn_completed, session_id: "session-late"}}
      assert length(Regex.scan(~r/^ARGV:/m, File.read!(trace_file))) == 1
    after
      File.rm_rf(test_root)
    end
  end

  test "claude subprocess reports malformed output before permission-denied failures" do
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

      assert {:ok, session} = Subprocess.start_session(workspace)

      assert {:error, {:claude_turn_failed, %{"permission_denials" => [_ | _]}}} =
               Subprocess.run_turn(session, "Do the forbidden thing", issue, on_message: &send(self(), {:claude_update, &1}))

      assert_receive {:claude_update, %{event: :malformed}}
      assert_receive {:claude_update, %{event: :session_started, session_id: "session-denied"}}
      assert_receive {:claude_update, %{event: :turn_started}}
      assert_receive {:claude_update, %{event: :permission_denied}}
    after
      File.rm_rf(test_root)
    end
  end

  test "claude subprocess fails clearly on unsupported control protocol messages" do
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

      assert {:ok, session} = Subprocess.start_session(workspace)

      assert {:error, {:unsupported_control_protocol, %{"type" => "control_request"}}} =
               Subprocess.run_turn(session, "Trigger control", issue, on_message: &send(self(), {:claude_update, &1}))

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
end
