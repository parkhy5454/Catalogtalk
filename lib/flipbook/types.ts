// Shape of what the public viewer may see (see get_flipbook() in schema.sql).
export type FlipbookPublic = {
  id: string
  title: string
  slug: string
  pdf_url: string | null
  thumb_url: string | null
  page_count: number
  views: number
  created_at: string
  has_password?: boolean
  lead_form?: boolean
  quote_form?: boolean
  order_form?: boolean
}

export type PageImage = {
  page_no: number
  image_url: string
}
