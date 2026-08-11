# task-XXX: <task title>

## Target file

```
src/path/to/file.ts # change
src/path/to/other.ts # change
src/test/file.test.ts # Add or change
```

## Requirements

- (Requirements in bullet points. Eliminate ambiguity and make it specific to a level that the implementer can work on without asking for judgment)
- (Example: Add RFC 5322 compliant email validation to `UserService.validateEmail()`)
- (Example: Add two normal and abnormal tests to the existing `UserServiceTest`)

## Completion conditions

- All existing tests (`path/to/test`) must pass
- New test cases have been added
- The build passes with `mvn compile` / `npm run build`

## Constraints

- (Specify files that must not be changed in this task and architectural rules that must be followed)
- (Example: Do not refer to Repository directly from Controller)
- (Example: Domain layer should not depend on Infrastructure)

## Commit

Once the implementation is complete, commit the changed files:

```bash
git add <target file>
git commit -m "<prefix>: <description>"
```

Commit prefix: `feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:`

## Completion marker

After the commit is complete, print the following **on its own line** at the end:

```
TASK_COMPLETE
```
