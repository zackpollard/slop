output "pages_projects" {
  description = "Cloudflare Pages project details"
  value = {
    for key, project in cloudflare_pages_project.project : key => {
      name      = project.name
      subdomain = project.subdomain
    }
  }
}

output "custom_domains" {
  description = "Custom domain mappings"
  value = {
    for key, domain in cloudflare_pages_domain.domain : key => {
      domain = domain.domain
      status = domain.status
    }
  }
}
