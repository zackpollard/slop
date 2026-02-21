variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone:DNS:Edit and Account:Cloudflare Pages:Edit permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "domain" {
  description = "Root domain name"
  type        = string
  default     = "zackpollard.pro"
}

variable "projects" {
  description = "Map of projects to deploy as Cloudflare Pages projects"
  type = map(object({
    subdomain = string
  }))
  default = {
    homepage = {
      subdomain = "slop"
    }
    roof-calculator = {
      subdomain = "roof-calculator.slop"
    }
  }
}
