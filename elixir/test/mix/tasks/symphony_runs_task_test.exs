defmodule Mix.Tasks.Symphony.RunsTaskTest do
  use SymphonyElixir.TestSupport

  import ExUnit.CaptureIO

  alias Mix.Tasks.Symphony.Runs
  alias SymphonyElixir.HttpServer

  defmodule StaticOrchestrator do
    use GenServer

    def start_link(opts) do
      name = Keyword.fetch!(opts, :name)
      GenServer.start_link(__MODULE__, opts, name: name)
    end

    def init(opts), do: {:ok, opts}

    def handle_call(:snapshot, _from, state) do
      {:reply, Keyword.fetch!(state, :snapshot), state}
    end
  end

  setup do
    endpoint_config = Application.get_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, [])
    server_port_override = Application.get_env(:symphony_elixir, :server_port_override)

    on_exit(fn ->
      Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)

      if is_nil(server_port_override) do
        Application.delete_env(:symphony_elixir, :server_port_override)
      else
        Application.put_env(:symphony_elixir, :server_port_override, server_port_override)
      end
    end)

    Mix.Task.reenable("symphony.runs")
    :ok
  end

  test "prints the default run history table" do
    port = start_observability_server!(run_snapshot())

    output =
      capture_io(fn ->
        Runs.run(["--port", Integer.to_string(port)])
      end)

    assert output =~ "Run History"
    assert output =~ "run-2"
    assert output =~ "MT-RETRY"
    assert output =~ "failed"
  end

  test "works from a fresh mix process" do
    port = start_observability_server!(run_snapshot())

    {output, 0} =
      System.cmd("mix", ["symphony.runs", "--port", Integer.to_string(port)],
        cd: File.cwd!(),
        stderr_to_stdout: true
      )

    assert output =~ "Run History"
    assert output =~ "run-4"
  end

  test "prints cost, retry, and run detail views" do
    port = start_observability_server!(run_snapshot())

    cost_output =
      capture_io(fn ->
        Runs.run(["--port", Integer.to_string(port), "--cost"])
      end)

    assert cost_output =~ "Cost Summary"
    assert cost_output =~ "codex"

    retries_output =
      capture_io(fn ->
        Runs.run(["--port", Integer.to_string(port), "--retries"])
      end)

    assert retries_output =~ "Retry Summary"
    assert retries_output =~ "MT-MULTI"

    run_output =
      capture_io(fn ->
        Runs.run(["--port", Integer.to_string(port), "--id", "run-4"])
      end)

    assert run_output =~ "Run run-4"
    assert run_output =~ "MT-MULTI"
    assert run_output =~ "agent exited: :boom"
  end

  test "requires an explicit port or configured server port" do
    assert_raise Mix.Error, ~r/No observability server port configured/, fn ->
      Runs.run([])
    end
  end

  test "prints help text and rejects invalid options" do
    help_output =
      capture_io(fn ->
        Runs.run(["--help"])
      end)

    assert help_output =~ "mix symphony.runs --issue MONO-171"

    assert_raise Mix.Error, ~r/Invalid option/, fn ->
      Runs.run(["--bogus"])
    end
  end

  test "supports json output and configured server port" do
    port = start_observability_server!(run_snapshot())
    Application.put_env(:symphony_elixir, :server_port_override, port)

    json_output =
      capture_io(fn ->
        Runs.run(["--json"])
      end)

    assert json_output =~ "\"view\": \"runs\""
    assert json_output =~ "\"id\": \"run-4\""
  end

  test "raises for missing runs" do
    port = start_observability_server!(run_snapshot())

    assert_raise Mix.Error, ~r/Run not found/, fn ->
      Runs.run(["--port", Integer.to_string(port), "--id", "run-missing"])
    end
  end

  test "raises for unavailable snapshots" do
    unavailable_port = start_unavailable_server!()

    assert_raise Mix.Error, ~r/Snapshot unavailable/, fn ->
      Runs.run(["--url", "http://127.0.0.1:#{unavailable_port}"])
    end
  end

  defp start_observability_server!(snapshot) do
    orchestrator_name = Module.concat(__MODULE__, :"Orchestrator#{System.unique_integer([:positive])}")

    start_supervised!({StaticOrchestrator, name: orchestrator_name, snapshot: snapshot})
    start_supervised!({HttpServer, host: "127.0.0.1", port: 0, orchestrator: orchestrator_name, snapshot_timeout_ms: 50})

    assert_eventually(fn ->
      is_integer(HttpServer.bound_port())
    end)

    HttpServer.bound_port()
  end

  defp start_unavailable_server! do
    unavailable_orchestrator = Module.concat(__MODULE__, :"MissingOrchestrator#{System.unique_integer([:positive])}")
    start_supervised!({HttpServer, host: "127.0.0.1", port: 0, orchestrator: unavailable_orchestrator, snapshot_timeout_ms: 50})

    assert_eventually(fn ->
      is_integer(HttpServer.bound_port())
    end)

    HttpServer.bound_port()
  end

  defp run_snapshot do
    now = DateTime.utc_now()

    %{
      running: [],
      retrying: [],
      blocked: [],
      usage_totals: %{input_tokens: 31, output_tokens: 16, total_tokens: 47, seconds_running: 9},
      rate_limits: %{},
      run_history: [
        %{
          id: "run-4",
          issue_id: "issue-multi",
          issue_identifier: "MT-MULTI",
          issue_title: "Retrying issue",
          state: "In Progress",
          slot_index: 0,
          ensemble_size: 1,
          agent_kind: "codex",
          worker_host: nil,
          workspace_path: nil,
          resume_id: "thread-multi",
          session_id: "thread-multi-turn-2",
          executor_pid: "5555",
          usage_totals: %{input_tokens: 20, output_tokens: 8, total_tokens: 28, seconds_running: 0},
          turn_count: 3,
          retry_attempt: 2,
          last_agent_timestamp: now,
          last_agent_event: :turn_failed,
          last_agent_message: "retry failed",
          started_at: now |> DateTime.add(-5, :second),
          ended_at: now |> DateTime.add(-4, :second),
          duration_ms: 1_111,
          outcome: :failed,
          failure_reason: "agent exited: :boom",
          cost: %{estimated_cost_usd: nil}
        },
        %{
          id: "run-3",
          issue_id: "issue-multi",
          issue_identifier: "MT-MULTI",
          issue_title: "Retrying issue",
          state: "In Progress",
          slot_index: 0,
          ensemble_size: 1,
          agent_kind: "codex",
          worker_host: nil,
          workspace_path: nil,
          resume_id: "thread-multi",
          session_id: "thread-multi-turn-1",
          executor_pid: "5555",
          usage_totals: %{input_tokens: 8, output_tokens: 4, total_tokens: 12, seconds_running: 0},
          turn_count: 1,
          retry_attempt: 1,
          last_agent_timestamp: now,
          last_agent_event: :turn_completed,
          last_agent_message: "completed",
          started_at: now |> DateTime.add(-8, :second),
          ended_at: now |> DateTime.add(-7, :second),
          duration_ms: 1_050,
          outcome: :success,
          failure_reason: nil,
          cost: %{estimated_cost_usd: nil}
        },
        %{
          id: "run-2",
          issue_id: "issue-retry",
          issue_identifier: "MT-RETRY",
          issue_title: "Single failure",
          state: "In Progress",
          slot_index: 0,
          ensemble_size: 1,
          agent_kind: "codex",
          worker_host: nil,
          workspace_path: nil,
          resume_id: "thread-retry",
          session_id: "thread-retry-turn-2",
          executor_pid: "4242",
          usage_totals: %{input_tokens: 10, output_tokens: 5, total_tokens: 15, seconds_running: 0},
          turn_count: 2,
          retry_attempt: 2,
          last_agent_timestamp: now,
          last_agent_event: :turn_failed,
          last_agent_message: "retry failed",
          started_at: now |> DateTime.add(-12, :second),
          ended_at: now |> DateTime.add(-11, :second),
          duration_ms: 1_234,
          outcome: :failed,
          failure_reason: "agent exited: :boom",
          cost: %{estimated_cost_usd: nil}
        },
        %{
          id: "run-1",
          issue_id: "issue-http",
          issue_identifier: "MT-HTTP",
          issue_title: "Active issue",
          state: "In Progress",
          slot_index: 0,
          ensemble_size: 1,
          agent_kind: "claude",
          worker_host: nil,
          workspace_path: nil,
          resume_id: "thread-http",
          session_id: "thread-http",
          executor_pid: nil,
          usage_totals: %{input_tokens: 4, output_tokens: 8, total_tokens: 12, seconds_running: 0},
          turn_count: 7,
          retry_attempt: 0,
          last_agent_timestamp: now,
          last_agent_event: :notification,
          last_agent_message: "rendered",
          started_at: now |> DateTime.add(-2, :second),
          ended_at: nil,
          outcome: :running,
          failure_reason: nil,
          cost: %{estimated_cost_usd: nil}
        }
      ]
    }
  end

  defp assert_eventually(fun, attempts \\ 20)

  defp assert_eventually(fun, attempts) when attempts > 0 do
    if fun.() do
      true
    else
      Process.sleep(25)
      assert_eventually(fun, attempts - 1)
    end
  end

  defp assert_eventually(_fun, 0), do: flunk("condition not met in time")
end
