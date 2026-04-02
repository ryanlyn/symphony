defmodule SymphonyElixir.Codex.Executor do
  @moduledoc false

  @behaviour SymphonyElixir.AgentExecutor

  alias SymphonyElixir.Codex.AppServer

  @impl true
  def start_session(workspace, opts \\ []) do
    resume_id =
      opts
      |> Keyword.get(:resume_metadata, %{})
      |> Map.get(:resume_id)

    with {:ok, app_session} <-
           AppServer.start_session(
             workspace,
             worker_host: Keyword.get(opts, :worker_host),
             resume_thread_id: resume_id
           ) do
      {:ok,
       %{
         agent_kind: "codex",
         app_session: app_session,
         resume_id: app_session.thread_id,
         session_id: nil
       }}
    end
  end

  @impl true
  def run_turn(%{app_session: app_session, resume_id: resume_id} = session, prompt, issue, opts) do
    on_message = Keyword.get(opts, :on_message, &default_on_message/1)

    case AppServer.run_turn(app_session, prompt, issue, on_message: normalize_on_message(on_message, resume_id)) do
      {:ok, turn_result} ->
        {:ok, %{session | resume_id: turn_result.thread_id, session_id: turn_result.session_id}, turn_result}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @impl true
  def stop_session(%{app_session: app_session}) do
    AppServer.stop_session(app_session)
  end

  @impl true
  def resume_metadata(session) when is_map(session) do
    %{
      agent_kind: "codex",
      resume_id: Map.get(session, :resume_id),
      session_id: Map.get(session, :session_id),
      thread_id: Map.get(session, :resume_id)
    }
  end

  defp normalize_on_message(on_message, resume_id) when is_function(on_message, 1) do
    fn update ->
      update =
        update
        |> Map.put_new(:agent_kind, "codex")
        |> Map.put_new(:resume_id, resume_id)
        |> maybe_put_executor_pid()

      on_message.(update)
    end
  end

  defp maybe_put_executor_pid(%{codex_app_server_pid: pid} = update) when is_binary(pid) do
    Map.put_new(update, :executor_pid, pid)
  end

  defp maybe_put_executor_pid(%{codex_app_server_pid: pid} = update) when is_integer(pid) do
    Map.put_new(update, :executor_pid, Integer.to_string(pid))
  end

  defp maybe_put_executor_pid(update), do: update

  defp default_on_message(_update), do: :ok
end
