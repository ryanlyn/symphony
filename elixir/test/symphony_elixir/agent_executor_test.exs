defmodule SymphonyElixir.AgentExecutorTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.AgentExecutor

  test "module_for_kind/1 returns the codex executor for codex" do
    assert AgentExecutor.module_for_kind("codex") == SymphonyElixir.Codex.Executor
  end

  test "module_for_kind/1 returns the claude executor for claude" do
    assert AgentExecutor.module_for_kind("claude") == SymphonyElixir.Claude.Executor
  end

  test "module_for_kind/1 raises for unsupported kinds" do
    assert_raise ArgumentError, ~r/Unsupported agent kind "codxe".*codex, claude/, fn ->
      AgentExecutor.module_for_kind("codxe")
    end
  end
end
