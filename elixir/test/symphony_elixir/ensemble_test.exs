defmodule SymphonyElixir.EnsembleTest do
  use SymphonyElixir.TestSupport

  describe "ensemble_size resolution" do
    test "issue label takes precedence over config" do
      write_workflow_file!(Workflow.workflow_file_path(), ensemble_size: 2)
      issue = %Issue{id: "i1", identifier: "T-1", title: "T", state: "Todo", labels: ["ensemble:3"]}
      assert Issue.ensemble_size(issue) == 3
      assert Config.settings!().agent.ensemble_size == 2
    end

    test "config default used when no label" do
      write_workflow_file!(Workflow.workflow_file_path(), ensemble_size: 2)
      issue = %Issue{id: "i1", identifier: "T-1", title: "T", state: "Todo", labels: []}
      assert Issue.ensemble_size(issue) == nil
      assert Config.settings!().agent.ensemble_size == 2
    end
  end

  describe "ToolServer barrier" do
    test "ensemble_size=1 passes state transition through directly" do
      test_pid = self()

      opts = [
        issue_id: "issue-1",
        slot_index: 0,
        ensemble_size: 1,
        linear_client: fn query, variables, _opts ->
          send(test_pid, {:linear_call, query, variables})
          {:ok, %{"data" => %{"issueUpdate" => %{"success" => true}}}}
        end
      ]

      query = "mutation { issueUpdate(id: $id, input: {stateId: $stateId}) { success } }"
      variables = %{"id" => "issue-1", "stateId" => "state-done"}

      {:ok, result} = SymphonyElixir.ToolServer.handle_linear_graphql(query, variables, opts)

      assert result["data"]["issueUpdate"]["success"] == true
      assert result["_symphony_barrier"]["status"] == "executed"
      assert result["_symphony_barrier"]["ensemble_size"] == 1
      assert_receive {:linear_call, ^query, ^variables}
    end

    test "non-state-transition queries pass through without barrier" do
      test_pid = self()

      opts = [
        issue_id: "issue-1",
        slot_index: 0,
        ensemble_size: 3,
        linear_client: fn query, variables, _opts ->
          send(test_pid, {:linear_call, query, variables})
          {:ok, %{"data" => %{"issue" => %{"id" => "issue-1"}}}}
        end
      ]

      query = "query { issue(id: $id) { id title } }"
      variables = %{"id" => "issue-1"}

      {:ok, result} = SymphonyElixir.ToolServer.handle_linear_graphql(query, variables, opts)

      assert result["data"]["issue"]["id"] == "issue-1"
      refute Map.has_key?(result, "_symphony_barrier")
      assert_receive {:linear_call, ^query, ^variables}
    end

    test "state_transition_mutation? detection" do
      assert SymphonyElixir.ToolServer.state_transition_mutation?(
               "mutation { issueUpdate(id: $id, input: {stateId: $sid}) { success } }",
               %{"id" => "i1", "stateId" => "s1"}
             )

      refute SymphonyElixir.ToolServer.state_transition_mutation?(
               "mutation { issueUpdate(id: $id, input: {title: $t}) { success } }",
               %{"id" => "i1", "title" => "new"}
             )

      refute SymphonyElixir.ToolServer.state_transition_mutation?(
               "query { issue(id: $id) { id } }",
               %{"id" => "i1"}
             )
    end
  end

  describe "workspace slot paths" do
    test "different slots create different workspace directories" do
      write_workflow_file!(Workflow.workflow_file_path())
      {:ok, ws0} = Workspace.create_for_issue("ENSEMBLE-1", nil, slot_index: 0)
      {:ok, ws1} = Workspace.create_for_issue("ENSEMBLE-1", nil, slot_index: 1)
      {:ok, ws2} = Workspace.create_for_issue("ENSEMBLE-1", nil, slot_index: 2)

      assert ws0 != ws1
      assert ws1 != ws2
      assert String.ends_with?(ws0, "/ENSEMBLE-1/0")
      assert String.ends_with?(ws1, "/ENSEMBLE-1/1")
      assert String.ends_with?(ws2, "/ENSEMBLE-1/2")

      assert File.dir?(ws0)
      assert File.dir?(ws1)
      assert File.dir?(ws2)
    end
  end

  describe "prompt builder ensemble context" do
    test "includes slot context for ensemble agents" do
      write_workflow_file!(Workflow.workflow_file_path())
      issue = %Issue{id: "i1", identifier: "T-1", title: "Test", description: "D", state: "Todo"}

      prompt = PromptBuilder.build_prompt(issue, slot_index: 2, ensemble_size: 5)
      assert prompt =~ "slot 2 of 5"
      assert prompt =~ "slot-2"
    end

    test "no ensemble context for single agents" do
      write_workflow_file!(Workflow.workflow_file_path())
      issue = %Issue{id: "i1", identifier: "T-1", title: "Test", description: "D", state: "Todo"}

      prompt = PromptBuilder.build_prompt(issue)
      refute prompt =~ "Ensemble context"
    end
  end
end
