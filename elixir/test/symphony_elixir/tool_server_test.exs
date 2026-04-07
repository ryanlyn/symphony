defmodule SymphonyElixir.ToolServerTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.ToolServer

  describe "handle_linear_graphql/3" do
    test "passes read queries through to the configured client" do
      test_pid = self()
      expected_response = %{"data" => %{"issues" => %{"nodes" => []}}}

      result =
        ToolServer.handle_linear_graphql(
          "query { issues { nodes { id } } }",
          %{},
          linear_client: fn query, variables, _opts ->
            send(test_pid, {:linear_called, query, variables})
            {:ok, expected_response}
          end
        )

      assert result == {:ok, expected_response}
      assert_received {:linear_called, "query { issues { nodes { id } } }", %{}}
    end

    test "passes issueUpdate mutations through without extra metadata" do
      test_pid = self()
      expected_response = %{"data" => %{"issueUpdate" => %{"success" => true}}}
      query = "mutation { issueUpdate(id: $id, input: $input) { success } }"
      variables = %{"id" => "issue-1", "stateId" => "state-done"}

      result =
        ToolServer.handle_linear_graphql(
          query,
          variables,
          linear_client: fn got_query, got_variables, _opts ->
            send(test_pid, {:linear_called, got_query, got_variables})
            {:ok, expected_response}
          end
        )

      assert result == {:ok, expected_response}
      assert {:ok, response} = result
      refute Map.has_key?(response, "_symphony_barrier")
      assert_received {:linear_called, ^query, ^variables}
    end

    test "propagates client errors" do
      result =
        ToolServer.handle_linear_graphql(
          "query { viewer { id } }",
          %{},
          linear_client: fn _query, _variables, _opts ->
            {:error, :timeout}
          end
        )

      assert result == {:error, :timeout}
    end
  end
end
