defmodule SymphonyElixir.ToolServerTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.ToolServer

  # ── state_transition_mutation?/2 ──────────────────────────────────────

  describe "state_transition_mutation?/2" do
    test "detects issueUpdate with stateId in variables" do
      query = "mutation { issueUpdate(id: $id, input: $input) { success } }"
      variables = %{"id" => "issue-1", "stateId" => "state-done"}

      assert ToolServer.state_transition_mutation?(query, variables)
    end

    test "rejects issueUpdate without stateId" do
      query = "mutation { issueUpdate(id: $id, input: $input) { success } }"
      variables = %{"id" => "issue-1", "title" => "New title"}

      refute ToolServer.state_transition_mutation?(query, variables)
    end

    test "rejects read queries" do
      query = "query { issues { nodes { id title } } }"
      variables = %{}

      refute ToolServer.state_transition_mutation?(query, variables)
    end

    test "rejects commentCreate mutations" do
      query = "mutation { commentCreate(input: $input) { success } }"
      variables = %{"stateId" => "state-done"}

      refute ToolServer.state_transition_mutation?(query, variables)
    end

    test "detects stateId nested in input variable" do
      query = "mutation { issueUpdate(id: $id, input: $input) { success } }"
      variables = %{"id" => "issue-1", "input" => %{"stateId" => "state-done"}}

      assert ToolServer.state_transition_mutation?(query, variables)
    end
  end

  # ── handle_linear_graphql/3 passthrough ───────────────────────────────

  describe "handle_linear_graphql/3 passthrough" do
    test "non-mutation queries pass through to linear_client" do
      test_pid = self()
      expected_response = %{"data" => %{"issues" => %{"nodes" => []}}}

      result =
        ToolServer.handle_linear_graphql(
          "query { issues { nodes { id } } }",
          %{},
          issue_id: "issue-1",
          slot_index: 0,
          ensemble_size: 1,
          linear_client: fn query, variables, _opts ->
            send(test_pid, {:linear_called, query, variables})
            {:ok, expected_response}
          end
        )

      assert result == {:ok, expected_response}
      assert_received {:linear_called, "query { issues { nodes { id } } }", %{}}
    end

    test "non-state-transition mutations pass through to linear_client" do
      expected_response = %{"data" => %{"commentCreate" => %{"success" => true}}}

      result =
        ToolServer.handle_linear_graphql(
          "mutation { commentCreate(input: $input) { success } }",
          %{"input" => %{"body" => "hello"}},
          issue_id: "issue-1",
          slot_index: 0,
          ensemble_size: 3,
          linear_client: fn _query, _variables, _opts ->
            {:ok, expected_response}
          end
        )

      assert result == {:ok, expected_response}
    end

    test "linear_client errors are propagated" do
      result =
        ToolServer.handle_linear_graphql(
          "query { viewer { id } }",
          %{},
          issue_id: "issue-1",
          slot_index: 0,
          ensemble_size: 1,
          linear_client: fn _query, _variables, _opts ->
            {:error, :timeout}
          end
        )

      assert result == {:error, :timeout}
    end
  end

  # ── handle_linear_graphql/3 ensemble_size=1 ───────────────────────────

  describe "handle_linear_graphql/3 with ensemble_size=1" do
    test "state transition executes directly and returns barrier metadata" do
      linear_response = %{"data" => %{"issueUpdate" => %{"success" => true}}}

      result =
        ToolServer.handle_linear_graphql(
          "mutation { issueUpdate(id: $id, input: $input) { success } }",
          %{"id" => "issue-1", "stateId" => "state-done"},
          issue_id: "issue-1",
          slot_index: 0,
          ensemble_size: 1,
          linear_client: fn _query, _variables, _opts ->
            {:ok, linear_response}
          end
        )

      assert {:ok, response} = result
      assert response["data"] == %{"issueUpdate" => %{"success" => true}}

      barrier = response["_symphony_barrier"]
      assert barrier["status"] == "executed"
      assert barrier["slot"] == 0
      assert barrier["ensemble_size"] == 1
      assert barrier["completed_slots"] == [0]
      assert is_binary(barrier["message"])
    end

    test "state transition with stateId nested in input executes directly" do
      linear_response = %{"data" => %{"issueUpdate" => %{"success" => true}}}

      result =
        ToolServer.handle_linear_graphql(
          "mutation { issueUpdate(id: $id, input: $input) { success } }",
          %{"id" => "issue-1", "input" => %{"stateId" => "state-done"}},
          issue_id: "issue-1",
          slot_index: 0,
          ensemble_size: 1,
          linear_client: fn _query, _variables, _opts ->
            {:ok, linear_response}
          end
        )

      assert {:ok, response} = result
      assert response["_symphony_barrier"]["status"] == "executed"
    end
  end

  # ── inject_barrier_metadata/5 ─────────────────────────────────────────

  describe "inject_barrier_metadata/5" do
    test "deferred: adds metadata with correct status, slot, ensemble_size" do
      response = %{"data" => %{"issueUpdate" => %{"success" => true}}}

      ensemble_state = %{
        completed_slots: MapSet.new([0, 2]),
        ensemble_size: 3
      }

      result = ToolServer.inject_barrier_metadata(response, :deferred, 1, "issue-1", ensemble_state)

      barrier = result["_symphony_barrier"]
      assert barrier["status"] == "deferred"
      assert barrier["slot"] == 1
      assert barrier["ensemble_size"] == 3
      assert barrier["completed_slots"] == [0, 2]
      assert is_binary(barrier["message"])
      assert barrier["message"] =~ "3 slots"
    end

    test "executed: adds metadata with correct status" do
      response = %{"data" => %{"issueUpdate" => %{"success" => true}}}

      ensemble_state = %{
        completed_slots: MapSet.new([0, 1, 2]),
        ensemble_size: 3
      }

      result = ToolServer.inject_barrier_metadata(response, :executed, 2, "issue-1", ensemble_state)

      barrier = result["_symphony_barrier"]
      assert barrier["status"] == "executed"
      assert barrier["slot"] == 2
      assert barrier["ensemble_size"] == 3
      assert barrier["completed_slots"] == [0, 1, 2]
    end

    test "preserves existing response data" do
      response = %{
        "data" => %{"issueUpdate" => %{"success" => true, "issue" => %{"id" => "abc"}}},
        "extensions" => %{"requestId" => "req-1"}
      }

      ensemble_state = %{completed_slots: MapSet.new([0]), ensemble_size: 1}

      result = ToolServer.inject_barrier_metadata(response, :executed, 0, "issue-1", ensemble_state)

      assert result["data"] == response["data"]
      assert result["extensions"] == response["extensions"]
      assert result["_symphony_barrier"]["status"] == "executed"
    end
  end
end
