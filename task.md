heavy refactor tasks, we should go one by one in this case, clearing exiting and running again to clear everything up in between tasks
status: done

- [x] remove the concept of response.md because its circular and is just a primitive version, not helping now
- [x] some files have become really big, we need a hard rule in the system prompt to keep files less than 300 lines, and 500 lines is a hard limit
- [x] three realms that must be clear, factual and linked: source code, docs/ path with semantic meaningful path tree containing markdown+yaml files in a standarized format with behavioural specs of the agent, and finally tests/ that group all the testing scripts that make sure the code honors the docs, but the ultimate truth is code so docs must not duplicate something that exists in code only reference
- [x] all adhoc scripts created to fulfill tasks must be stored in a gitignored agent/ path within a utils/ folder and only kept if future reutilization is factual