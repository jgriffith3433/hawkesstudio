@echo off
rem J runs this (it deletes): the old beta services and agent job in us-east4, after betas-to-us-central1.bat and a
rem check that https://gen-beta.hawkesgen.ai and https://studio-beta.hawkesgen.ai answer from us-central1.
call gcloud run services delete gen-beta --project hawkes-staging --region us-east4
call gcloud run services delete studio-beta --project hawkes-staging --region us-east4
call gcloud run jobs delete studio-agent-beta --project hawkes-staging --region us-east4
