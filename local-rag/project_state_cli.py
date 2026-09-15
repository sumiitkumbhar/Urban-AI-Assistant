"""Quick terminal test for structured project state (project_state.py),
mirroring gis/gis_cli.py's and query_cli.py's role for their own
pieces.

    python3 project_state_cli.py create "123 Elm House" --postcode "SW1V 3LX"
    python3 project_state_cli.py list
    python3 project_state_cli.py show 1
    python3 project_state_cli.py update 1 --proposed-use "residential extension" --units 4 --stage pre-app
    python3 project_state_cli.py refresh-constraints 1
    python3 project_state_cli.py add-question 1 "Is the rear extension within permitted development?"
    python3 project_state_cli.py resolve-question 3
    python3 project_state_cli.py context 1
"""

import argparse
import json
import sys

import project_state as ps


def _print_project(project):
    print(f"[{project['id']}] {project['name']}")
    if project["postcode"]:
        print(f"  Postcode: {project['postcode']}")
    print(f"  Location: {project['lat']}, {project['lon']}")
    print(f"  Authority: {project['geography'] or 'unknown'} ({project['lpa_reference'] or 'no LPA match'})")
    for label, key in (
        ("Proposed use", "proposed_use"),
        ("Units", "units"),
        ("Storeys", "storeys"),
        ("Floorspace (sqm)", "floorspace_sqm"),
        ("Height (m)", "height_m"),
        ("Stage", "stage"),
    ):
        if project[key] is not None:
            print(f"  {label}: {project[key]}")
    print(f"  Constraints checked: {project['constraints_checked_at'] or 'never'}")
    print(f"  Updated: {project['updated_at']}")
    if project["open_questions"]:
        print("  Open questions:")
        for q in project["open_questions"]:
            status = "resolved" if q["resolved"] else "open"
            print(f"    [{q['id']}] ({status}) {q['question']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser("create")
    p_create.add_argument("name")
    p_create.add_argument("--postcode")
    p_create.add_argument("--lat", type=float)
    p_create.add_argument("--lon", type=float)

    sub.add_parser("list")

    p_show = sub.add_parser("show")
    p_show.add_argument("project_id", type=int)

    p_update = sub.add_parser("update")
    p_update.add_argument("project_id", type=int)
    p_update.add_argument("--name")
    p_update.add_argument("--proposed-use")
    p_update.add_argument("--units", type=int)
    p_update.add_argument("--storeys", type=int)
    p_update.add_argument("--floorspace-sqm", type=float)
    p_update.add_argument("--height-m", type=float)
    p_update.add_argument("--stage")

    p_refresh = sub.add_parser("refresh-constraints")
    p_refresh.add_argument("project_id", type=int)

    p_add_q = sub.add_parser("add-question")
    p_add_q.add_argument("project_id", type=int)
    p_add_q.add_argument("question")

    p_resolve_q = sub.add_parser("resolve-question")
    p_resolve_q.add_argument("question_id", type=int)

    p_context = sub.add_parser("context")
    p_context.add_argument("project_id", type=int)

    args = parser.parse_args()

    if args.command == "create":
        try:
            project = ps.create_project(args.name, postcode=args.postcode, lat=args.lat, lon=args.lon)
        except ValueError as e:
            print(str(e))
            sys.exit(1)
        _print_project(project)

    elif args.command == "list":
        projects = ps.list_projects()
        if not projects:
            print("No projects yet.")
        for project in projects:
            location = project["postcode"] or f"{project['lat']},{project['lon']}"
            authority = project["geography"] or "unknown authority"
            print(f"[{project['id']}] {project['name']} - {location} ({authority})")

    elif args.command == "show":
        project = ps.get_project(args.project_id)
        if project is None:
            print(f"No project with id {args.project_id}.")
            sys.exit(1)
        _print_project(project)

    elif args.command == "update":
        fields = {}
        for arg_name, field_name in (
            ("name", "name"),
            ("proposed_use", "proposed_use"),
            ("units", "units"),
            ("storeys", "storeys"),
            ("floorspace_sqm", "floorspace_sqm"),
            ("height_m", "height_m"),
            ("stage", "stage"),
        ):
            value = getattr(args, arg_name)
            if value is not None:
                fields[field_name] = value
        if not fields:
            print("No fields given to update.")
            sys.exit(1)
        project = ps.update_project(args.project_id, **fields)
        if project is None:
            print(f"No project with id {args.project_id}.")
            sys.exit(1)
        _print_project(project)

    elif args.command == "refresh-constraints":
        project = ps.refresh_constraints(args.project_id)
        if project is None:
            print(f"No project with id {args.project_id}.")
            sys.exit(1)
        print(json.dumps(project["constraints"], indent=2, default=str))

    elif args.command == "add-question":
        question = ps.add_open_question(args.project_id, args.question)
        if question is None:
            print(f"No project with id {args.project_id}.")
            sys.exit(1)
        print(f"[{question['id']}] {question['question']}")

    elif args.command == "resolve-question":
        question = ps.resolve_open_question(args.question_id)
        if question is None:
            print(f"No question with id {args.question_id}.")
            sys.exit(1)
        print(f"[{question['id']}] resolved: {question['question']}")

    elif args.command == "context":
        summary = ps.build_context_summary(args.project_id)
        if summary is None:
            print(f"No project with id {args.project_id}.")
            sys.exit(1)
        print(summary)


if __name__ == "__main__":
    main()
