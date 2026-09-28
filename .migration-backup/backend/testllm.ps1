$payload = @{
  profiles = @(
    @{ platform = "instagram"; url = "https://www.instagram.com/guilhermelimait"; display_name = "guilhermelimait"; bio = "placeholder bio"; category = "Social" }
    @{ platform = "github"; url = "https://github.com/guilhermelimait"; display_name = "guilhermelimait"; bio = "code profile"; category = "Dev" }
  )
  use_llm    = $true
  llm_model  = "smollm:latest"
  ollama_host= "http://localhost:11434"
  api_mode   = "ollama"
  username   = "guilhermelimait"
}
$json = $payload | ConvertTo-Json -Depth 6
$res  = Invoke-RestMethod -Method Post -Uri "http://localhost:8000/api/profile/analyze" -Body $json -ContentType "application/json"
$res | ConvertTo-Json -Depth 6