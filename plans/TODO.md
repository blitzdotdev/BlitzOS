# Must
- implement the plans/IDENTITY.md model 
- in a fresh worktree/branch, test self-hosting e2e 
  - create test collaborator account, share an agent workspace
  - revoke access to shared agent workspace
- integrations. two modes:
  - org admin: adds static tokens, not individual but org-level oauth tokens with scoped access. then creates workspaces with those tokens leased 
  - member: in the running workspaces' integrations tab, whenever they need it, browse + add integrations with oauth tied to their account. 
- implement anti-slop and overengineering rules in the codebase

# e2e customer test

Branches
- a) Org admin sets up new Cloudflare Account, mints required API tokens (its documented, very easy)
- b) Org admin types one prompt and sets it up in blitz.dev 

Common stream
- Org admin does google SSO. Adds org members by email or mints an invite link and sends it to them. 
  - any member creates dedicated workspace, adds folders + files to it. Clicks share /workspace OR some folder/file in /workspace with invited members XYZ, now members XYZ gets those folders and files (Google-drive like last-edit is saved model) 
    - decide: do all the shared folders/files data sync and show in /workspace/shared of every agent workspace? 
  - how about clicking share on just the workspace? if you give view access, what happens right now? edit access, what happens right now? 
- User signs up and creates a new workspace. Open claude in either chat or claude code tab, and logs in to begin using. 


# Nice to have 
- 