from agent.course_agent import analyze_assignment


EXAMPLE_ASSIGNMENT = (
    "Build a CNN classifier, evaluate it on the test set, submit the source "
    "code and a 5-page report by August 31 at 23:59."
)


if __name__ == "__main__":
    result = analyze_assignment(EXAMPLE_ASSIGNMENT)
    print(result.model_dump_json(indent=2))