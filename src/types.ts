import { z } from 'zod'
import { type D1Database } from '@cloudflare/workers-types'

export interface GeoJSONFeature {
    type: 'Feature'
    properties: Record<string, unknown>
    geometry: {
        type: string
        coordinates: unknown
    }
}

export interface GeoJSONFeatureCollection {
    type: 'FeatureCollection'
    features: GeoJSONFeature[]
}

export type CloudflareBindings = {
    OIDC_ISSUER: string
    JWT_SHARED_SECRET: string
    PKI_ENCRYPTION_SECRET: string
    db: D1Database
}

const BASE64_REGEX = /^[A-Za-z0-9+/=]+$/

export const deviceIdSchema = z
    .string()
    .trim()
    .min(3, 'device id too short')
    .max(128, 'device id too long')
    .regex(/^[A-Za-z0-9:_-]+$/, 'device id contains invalid characters')

export const csrBodySchema = z.object({
    csr: z.string().trim().min(1).max(12000)
}).superRefine((value, ctx) => {
    const candidate = value.csr || ''
    if (!candidate.includes('-----BEGIN CERTIFICATE REQUEST-----') || !candidate.includes('-----END CERTIFICATE REQUEST-----')) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'csr must be a valid PEM encoded certificate request'
        })
    }
})

export const dsParamsSchema = z.object({
    ds_key_id: z.number().int().min(1).max(9),
    rsa_len: z.number().int().min(31).max(128),
    cipher_c: z.string().min(1).max(4096).regex(BASE64_REGEX, 'cipher_c must be base64 encoded'),
    iv: z.string().min(1).max(64).regex(BASE64_REGEX, 'iv must be base64 encoded')
})

export type DeviceId = z.infer<typeof deviceIdSchema>
export type DsParams = z.infer<typeof dsParamsSchema>

// ============================================================================
// Multi-tenant PKI Schemas
// ============================================================================

export const tenantModeSchema = z.enum(['managed', 'byoi', 'byoca', 'hybrid'])
export const algorithmSchema = z.enum(['rsa', 'ecc'])
export const keySpecSchema = z.enum(['rsa-2048', 'rsa-3072', 'rsa-4096', 'ecc-p256', 'ecc-p384'])

export const createTenantSchema = z.object({
    name: z.string().trim().min(1).max(255),
    mode: tenantModeSchema.optional().default('managed')
})

export const updateTenantSchema = z.object({
    name: z.string().trim().min(1).max(255).optional(),
    status: z.enum(['active', 'suspended']).optional()
})

export const createPlatformRootSchema = z.object({
    algorithm: algorithmSchema,
    key_spec: keySpecSchema,
    name: z.string().trim().min(1).max(255),
    validity_years: z.number().int().min(1).max(30).optional().default(20)
})

export const createIntermediateSchema = z.object({
    algorithm: algorithmSchema,
    key_spec: keySpecSchema,
    root_ca_id: z.string().optional(),
    name: z.string().trim().min(1).max(255).optional(),
    validity_years: z.number().int().min(1).max(20).optional().default(10)
})

export const uploadRootSchema = z.object({
    certificate_pem: z.string().trim().min(1),
    private_key_pem: z.string().trim().optional(),
    algorithm: algorithmSchema
})

export const uploadIntermediateSchema = z.object({
    certificate_pem: z.string().trim().min(1),
    private_key_pem: z.string().trim().min(1)
})

export const signCsrSchema = z.object({
    csr: z.string().trim().min(1).max(12000),
    chain_algorithm: algorithmSchema.optional(),
    validity_days: z.number().int().min(1).max(3650).optional().default(365),
    device_id: z.string().trim().max(255).optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
}).superRefine((value, ctx) => {
    const candidate = value.csr || ''
    if (!candidate.includes('-----BEGIN CERTIFICATE REQUEST-----') || !candidate.includes('-----END CERTIFICATE REQUEST-----')) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'csr must be a valid PEM encoded certificate request'
        })
    }
})

export const revokeCertSchema = z.object({
    reason: z.enum(['unspecified', 'keyCompromise', 'caCompromise', 'affiliationChanged', 'superseded', 'cessationOfOperation']).optional()
})

export const assignCaSchema = z.object({
    ca_id: z.number().int().positive()
})

export type TenantMode = z.infer<typeof tenantModeSchema>
export type Algorithm = z.infer<typeof algorithmSchema>
export type KeySpec = z.infer<typeof keySpecSchema>
export type CreateTenant = z.infer<typeof createTenantSchema>
export type UpdateTenant = z.infer<typeof updateTenantSchema>
export type CreatePlatformRoot = z.infer<typeof createPlatformRootSchema>
export type CreateIntermediate = z.infer<typeof createIntermediateSchema>
export type UploadRoot = z.infer<typeof uploadRootSchema>
export type UploadIntermediate = z.infer<typeof uploadIntermediateSchema>
export type SignCsr = z.infer<typeof signCsrSchema>
export type RevokeCert = z.infer<typeof revokeCertSchema>
export type AssignCa = z.infer<typeof assignCaSchema>

export const swaggerDocument = {
    openapi: '3.1.0',
    info: {
        title: 'Koios PKI API',
        version: '2.0.0',
        description: 'Multi-tenant Public Key Infrastructure API for device provisioning and certificate signing.'
    },
    servers: [
        {
            url: 'https://{host}',
            description: 'Production',
            variables: {
                host: { default: 'api.koios.sh' }
            }
        }
    ],
    tags: [
        { name: 'PKI', description: 'Legacy public PKI endpoints' },
        { name: 'Admin', description: 'Platform administration endpoints' },
        { name: 'Tenant', description: 'Tenant-scoped PKI operations' }
    ],
    paths: {
        '/v1/pki/ca.crt': {
            get: {
                tags: ['PKI'],
                summary: 'Get CA certificates',
                description: 'Download root CA certificate(s) for trust store installation.',
                responses: {
                    '200': {
                        description: 'PEM-encoded CA certificate(s)',
                        content: {
                            'application/x-pem-file': {
                                schema: { type: 'string' }
                            }
                        }
                    },
                    '500': { description: 'CA certificates not available' }
                }
            }
        },
        '/v1/pki/crl.pem': {
            get: {
                tags: ['PKI'],
                summary: 'Get Certificate Revocation List',
                description: 'Download current CRL for certificate validation.',
                responses: {
                    '200': {
                        description: 'PEM-encoded CRL',
                        content: {
                            'application/x-pem-file': {
                                schema: { type: 'string' }
                            }
                        }
                    },
                    '500': { description: 'CRL not available' }
                }
            }
        },
        '/v1/pki/sign': {
            post: {
                tags: ['PKI'],
                summary: 'Sign CSR',
                description: 'Signs a certificate signing request. Requires koios-factory role.',
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'multipart/form-data': {
                            schema: {
                                type: 'object',
                                properties: {
                                    csr: { type: 'string', description: 'PEM-encoded CSR' }
                                },
                                required: ['csr']
                            }
                        }
                    }
                },
                responses: {
                    '200': {
                        description: 'Certificate chain (leaf + intermediates + root)',
                        content: {
                            'application/x-pem-file': {
                                schema: { type: 'string' }
                            }
                        }
                    },
                    '400': { description: 'Invalid CSR' },
                    '401': { description: 'Missing or invalid token' },
                    '403': { description: 'Missing koios-factory role' },
                    '502': { description: 'Signing failed' }
                }
            }
        },
        '/v1/pki/ds_params': {
            get: {
                tags: ['PKI'],
                summary: 'Get device parameters',
                parameters: [
                    {
                        name: 'x-device-id',
                        in: 'header',
                        required: true,
                        schema: { type: 'string' },
                        description: 'Device identifier'
                    }
                ],
                responses: {
                    '200': {
                        description: 'Device parameters',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/DsParams' }
                            }
                        }
                    },
                    '400': { description: 'Invalid device ID' },
                    '404': { description: 'Device not found' }
                }
            },
            post: {
                tags: ['PKI'],
                summary: 'Store device parameters',
                parameters: [
                    {
                        name: 'x-device-id',
                        in: 'header',
                        required: true,
                        schema: { type: 'string' },
                        description: 'Device identifier'
                    }
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/DsParams' }
                        }
                    }
                },
                responses: {
                    '200': {
                        description: 'Result',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: { type: 'string', enum: ['created', 'exists'] }
                                    },
                                    required: ['status']
                                }
                            }
                        }
                    },
                    '400': { description: 'Invalid request' }
                }
            }
        },
        '/v1/admin/tenants': {
            get: {
                tags: ['Admin'],
                summary: 'List tenants',
                security: [{ bearerAuth: [] }],
                responses: {
                    '200': {
                        description: 'List of tenants',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        tenants: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/Tenant' }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '401': { description: 'Missing or invalid token' },
                    '403': { description: 'Admin role required' }
                }
            },
            post: {
                tags: ['Admin'],
                summary: 'Create tenant',
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/CreateTenant' }
                        }
                    }
                },
                responses: {
                    '201': {
                        description: 'Tenant created',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Tenant' }
                            }
                        }
                    },
                    '400': { description: 'Invalid request' },
                    '409': { description: 'Tenant name already exists' }
                }
            }
        },
        '/v1/admin/tenants/{id}': {
            get: {
                tags: ['Admin'],
                summary: 'Get tenant',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
                ],
                responses: {
                    '200': {
                        description: 'Tenant details',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Tenant' }
                            }
                        }
                    },
                    '404': { description: 'Tenant not found' }
                }
            },
            patch: {
                tags: ['Admin'],
                summary: 'Update tenant',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/UpdateTenant' }
                        }
                    }
                },
                responses: {
                    '200': { description: 'Tenant updated' },
                    '404': { description: 'Tenant not found' }
                }
            },
            delete: {
                tags: ['Admin'],
                summary: 'Delete tenant (soft delete)',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
                ],
                responses: {
                    '200': { description: 'Tenant deleted' },
                    '404': { description: 'Tenant not found' }
                }
            }
        },
        '/v1/admin/roots': {
            get: {
                tags: ['Admin'],
                summary: 'List platform root CAs',
                security: [{ bearerAuth: [] }],
                responses: {
                    '200': {
                        description: 'List of platform root CAs',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        roots: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/CA' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            post: {
                tags: ['Admin'],
                summary: 'Create platform root CA',
                description: 'Generates a new platform root CA with the specified algorithm and key spec.',
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/CreatePlatformRoot' }
                        }
                    }
                },
                responses: {
                    '201': {
                        description: 'Root CA created',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CA' }
                            }
                        }
                    },
                    '409': { description: 'CA with this name already exists' }
                }
            }
        },
        '/v1/admin/intermediates': {
            get: {
                tags: ['Admin'],
                summary: 'List platform intermediate CAs',
                security: [{ bearerAuth: [] }],
                responses: {
                    '200': {
                        description: 'List of platform intermediate CAs',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        intermediates: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/CA' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            post: {
                tags: ['Admin'],
                summary: 'Create platform intermediate CA',
                description: 'Generates a new platform intermediate CA signed by a platform root.',
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/CreateIntermediate' }
                        }
                    }
                },
                responses: {
                    '201': {
                        description: 'Intermediate CA created',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CA' }
                            }
                        }
                    },
                    '409': { description: 'CA with this name already exists' },
                    '500': { description: 'Failed to create intermediate' }
                }
            }
        },
        '/v1/admin/tenants/{id}/assign-ca': {
            post: {
                tags: ['Admin'],
                summary: 'Assign CA to tenant',
                description: 'Assigns a platform intermediate CA to a tenant, creating a tenant-specific copy.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/AssignCa' }
                        }
                    }
                },
                responses: {
                    '200': { description: 'CA assigned successfully' },
                    '404': { description: 'Tenant or CA not found' },
                    '409': { description: 'Tenant already has a CA for this algorithm' }
                }
            }
        },
        '/v1/admin/stats': {
            get: {
                tags: ['Admin'],
                summary: 'Get platform statistics',
                description: 'Returns platform-wide statistics including tenant, CA, and certificate counts.',
                security: [{ bearerAuth: [] }],
                responses: {
                    '200': {
                        description: 'Platform statistics',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/AdminStats' }
                            }
                        }
                    }
                }
            }
        },
        '/v1/admin/audit': {
            get: {
                tags: ['Admin'],
                summary: 'Get platform audit log',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
                    { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }
                ],
                responses: {
                    '200': {
                        description: 'Audit log entries',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        logs: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/AuditEntry' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        '/v1/tenants/{tenantId}/cas': {
            get: {
                tags: ['Tenant'],
                summary: 'List tenant CAs',
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }
                ],
                responses: {
                    '200': {
                        description: 'List of tenant CAs',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        cas: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/CA' }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '404': { description: 'Tenant not found' }
                }
            }
        },
        '/v1/tenants/{tenantId}/intermediates': {
            post: {
                tags: ['Tenant'],
                summary: 'Create intermediate CA',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/CreateIntermediate' }
                        }
                    }
                },
                responses: {
                    '201': {
                        description: 'Intermediate CA created',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CA' }
                            }
                        }
                    },
                    '404': { description: 'Tenant not found' },
                    '500': { description: 'Failed to create intermediate' }
                }
            }
        },
        '/v1/tenants/{tenantId}/roots': {
            post: {
                tags: ['Tenant'],
                summary: 'Upload tenant root CA',
                description: 'Upload a customer-provided root CA certificate with optional private key.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/UploadRoot' }
                        }
                    }
                },
                responses: {
                    '201': {
                        description: 'Root CA uploaded',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CA' }
                            }
                        }
                    },
                    '400': { description: 'Invalid certificate or key format' },
                    '409': { description: 'Root CA already exists' }
                }
            }
        },
        '/v1/tenants/{tenantId}/intermediates/upload': {
            post: {
                tags: ['Tenant'],
                summary: 'Upload pre-signed intermediate CA',
                description: 'Upload a customer-provided pre-signed intermediate CA with private key.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/UploadIntermediate' }
                        }
                    }
                },
                responses: {
                    '201': {
                        description: 'Intermediate CA uploaded',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CA' }
                            }
                        }
                    },
                    '400': { description: 'Invalid certificate or key format' },
                    '409': { description: 'Intermediate CA already exists' }
                }
            }
        },
        '/v1/tenants/{tenantId}/intermediates/csr': {
            post: {
                tags: ['Tenant'],
                summary: 'Sign intermediate CA CSR',
                description: 'Sign a CSR to create an intermediate CA. Customer provides CSR + private key.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/SignIntermediateCsr' }
                        }
                    }
                },
                responses: {
                    '201': {
                        description: 'Intermediate CA created',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CA' }
                            }
                        }
                    },
                    '400': { description: 'Invalid CSR or key' },
                    '403': { description: 'Access denied to root CA' },
                    '404': { description: 'Root CA not found' },
                    '409': { description: 'CA already exists' }
                }
            }
        },
        '/v1/tenants/{tenantId}/cas/{caId}': {
            get: {
                tags: ['Tenant'],
                summary: 'Get CA status',
                description: 'Get the current status of a CA including supersession info and cross-signatures.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'caId', in: 'path', required: true, schema: { type: 'integer' } }
                ],
                responses: {
                    '200': {
                        description: 'CA status',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CaStatus' }
                            }
                        }
                    },
                    '404': { description: 'CA not found' }
                }
            }
        },
        '/v1/tenants/{tenantId}/cas/{caId}/roll': {
            post: {
                tags: ['Tenant'],
                summary: 'Roll CA',
                description: 'Create a new CA with the same parameters, mark old CA as rolling. Optionally cross-sign.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'caId', in: 'path', required: true, schema: { type: 'integer' } }
                ],
                requestBody: {
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/RollCa' }
                        }
                    }
                },
                responses: {
                    '201': {
                        description: 'CA rolled successfully',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/RolledCa' }
                            }
                        }
                    },
                    '400': { description: 'Cannot roll CA (invalid status or type)' },
                    '403': { description: 'Access denied' },
                    '404': { description: 'CA not found' }
                }
            }
        },
        '/v1/tenants/{tenantId}/cas/{caId}/revoke': {
            post: {
                tags: ['Tenant'],
                summary: 'Revoke CA',
                description: 'Emergency revocation of a CA. All certificates issued by this CA should be considered compromised.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'caId', in: 'path', required: true, schema: { type: 'integer' } }
                ],
                requestBody: {
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/RevokeCa' }
                        }
                    }
                },
                responses: {
                    '200': {
                        description: 'CA revoked',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CaStatusResult' }
                            }
                        }
                    },
                    '400': { description: 'Invalid status transition' },
                    '403': { description: 'Access denied' },
                    '404': { description: 'CA not found' }
                }
            }
        },
        '/v1/tenants/{tenantId}/cas/{caId}/retire': {
            post: {
                tags: ['Tenant'],
                summary: 'Retire CA',
                description: 'Retire a CA after rolling grace period. CA can no longer sign, only validate.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'caId', in: 'path', required: true, schema: { type: 'integer' } }
                ],
                responses: {
                    '200': {
                        description: 'CA retired',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CaStatusResult' }
                            }
                        }
                    },
                    '400': { description: 'Invalid status transition (must be rolling)' },
                    '403': { description: 'Access denied' },
                    '404': { description: 'CA not found' }
                }
            }
        },
        '/v1/tenants/{tenantId}/cas/{caId}/active': {
            get: {
                tags: ['Tenant'],
                summary: 'Get active successor',
                description: 'Follow the supersession chain to find the current active CA.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'caId', in: 'path', required: true, schema: { type: 'integer' } }
                ],
                responses: {
                    '200': {
                        description: 'Active CA in chain',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CaStatusResult' }
                            }
                        }
                    },
                    '404': { description: 'CA not found' }
                }
            }
        },
        '/v1/tenants/{tenantId}/sign': {
            post: {
                tags: ['Tenant'],
                summary: 'Sign CSR for tenant',
                description: 'Signs a CSR using the tenant\'s intermediate CA. Supports algorithm selection.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/SignCsr' }
                        }
                    }
                },
                responses: {
                    '200': {
                        description: 'Certificate chain',
                        headers: {
                            'X-Serial-Number': {
                                schema: { type: 'string' },
                                description: 'Serial number of the issued certificate'
                            }
                        },
                        content: {
                            'application/x-pem-file': {
                                schema: { type: 'string' }
                            }
                        }
                    },
                    '400': { description: 'Invalid CSR' },
                    '404': { description: 'Tenant not found' },
                    '500': { description: 'Signing failed' }
                }
            }
        },
        '/v1/tenants/{tenantId}/certificates': {
            get: {
                tags: ['Tenant'],
                summary: 'List issued certificates',
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
                    { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
                    { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'revoked', 'expired'] } }
                ],
                responses: {
                    '200': {
                        description: 'List of certificates',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        certificates: { type: 'array', items: { $ref: '#/components/schemas/Certificate' } }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        '/v1/tenants/{tenantId}/certificates/expiring': {
            get: {
                tags: ['Tenant'],
                summary: 'List certificates expiring soon',
                description: 'Returns certificates that will expire within the specified number of days.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'days', in: 'query', schema: { type: 'integer', default: 30, description: 'Number of days to look ahead' } },
                    { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
                    { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }
                ],
                responses: {
                    '200': {
                        description: 'List of expiring certificates',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        certificates: { type: 'array', items: { $ref: '#/components/schemas/Certificate' } },
                                        query: {
                                            type: 'object',
                                            properties: {
                                                days: { type: 'integer' },
                                                cutoff_date: { type: 'string', format: 'date-time' }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        '/v1/tenants/{tenantId}/certificates/{serial}': {
            get: {
                tags: ['Tenant'],
                summary: 'Get certificate details',
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'serial', in: 'path', required: true, schema: { type: 'string' } }
                ],
                responses: {
                    '200': {
                        description: 'Certificate details',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Certificate' }
                            }
                        }
                    },
                    '404': { description: 'Certificate not found' }
                }
            }
        },
        '/v1/tenants/{tenantId}/certificates/{serial}/revoke': {
            post: {
                tags: ['Tenant'],
                summary: 'Revoke certificate',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'serial', in: 'path', required: true, schema: { type: 'string' } }
                ],
                requestBody: {
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/RevokeCert' }
                        }
                    }
                },
                responses: {
                    '200': { description: 'Certificate revoked' },
                    '404': { description: 'Certificate not found' }
                }
            }
        },
        '/v1/tenants/{tenantId}/chain.pem': {
            get: {
                tags: ['Tenant'],
                summary: 'Get tenant CA chain',
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'alg', in: 'query', schema: { type: 'string', enum: ['rsa', 'ecc'], default: 'rsa' } }
                ],
                responses: {
                    '200': {
                        description: 'CA chain in PEM format',
                        content: {
                            'application/x-pem-file': {
                                schema: { type: 'string' }
                            }
                        }
                    },
                    '404': { description: 'Tenant or chain not found' }
                }
            }
        },
        '/v1/tenants/{tenantId}/crl.pem': {
            get: {
                tags: ['Tenant'],
                summary: 'Get tenant CRL',
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'alg', in: 'query', schema: { type: 'string', enum: ['rsa', 'ecc'] } }
                ],
                responses: {
                    '200': {
                        description: 'CRL in PEM format',
                        content: {
                            'application/x-pem-file': {
                                schema: { type: 'string' }
                            }
                        }
                    },
                    '500': { description: 'CRL generation failed' }
                }
            }
        },
        '/v1/tenants/{tenantId}/stats': {
            get: {
                tags: ['Tenant'],
                summary: 'Get tenant statistics',
                description: 'Returns certificate and CA statistics for the tenant.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }
                ],
                responses: {
                    '200': {
                        description: 'Tenant statistics',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/TenantStats' }
                            }
                        }
                    }
                }
            }
        },
        '/v1/tenants/{tenantId}/audit': {
            get: {
                tags: ['Tenant'],
                summary: 'Get tenant audit log',
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
                    { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }
                ],
                responses: {
                    '200': {
                        description: 'Audit log entries',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        logs: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/AuditEntry' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        '/v1/tenants/{tenantId}/credentials': {
            get: {
                tags: ['Tenant'],
                summary: 'List signing credentials',
                description: 'List all signing credentials for M2M authentication.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'include_revoked', in: 'query', schema: { type: 'boolean', default: false } }
                ],
                responses: {
                    '200': {
                        description: 'List of credentials (public keys only)',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        credentials: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/Credential' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            post: {
                tags: ['Tenant'],
                summary: 'Create signing credential',
                description: 'Create a new signing credential. Returns private key ONLY at creation time.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/CreateCredential' }
                        }
                    }
                },
                responses: {
                    '201': {
                        description: 'Credential created (includes private key, shown only once)',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CredentialWithPrivateKey' }
                            }
                        }
                    },
                    '409': { description: 'Credential with this name already exists' }
                }
            }
        },
        '/v1/tenants/{tenantId}/credentials/{credentialId}': {
            get: {
                tags: ['Tenant'],
                summary: 'Get credential details',
                description: 'Get details of a specific credential (public key only).',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'credentialId', in: 'path', required: true, schema: { type: 'string' } }
                ],
                responses: {
                    '200': {
                        description: 'Credential details',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Credential' }
                            }
                        }
                    },
                    '404': { description: 'Credential not found' }
                }
            },
            delete: {
                tags: ['Tenant'],
                summary: 'Revoke credential',
                description: 'Revoke a signing credential. JWTs signed with this credential will no longer be accepted.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'credentialId', in: 'path', required: true, schema: { type: 'string' } }
                ],
                responses: {
                    '200': {
                        description: 'Credential revoked',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean' },
                                        revoked_at: { type: 'integer' }
                                    }
                                }
                            }
                        }
                    },
                    '400': { description: 'Credential already revoked' },
                    '404': { description: 'Credential not found' }
                }
            }
        },
        '/v1/tenants/{tenantId}/credentials/{credentialId}/rotate': {
            post: {
                tags: ['Tenant'],
                summary: 'Rotate credential',
                description: 'Generate a new keypair and revoke the old credential. Returns new private key ONLY at rotation time.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
                    { name: 'credentialId', in: 'path', required: true, schema: { type: 'string' } }
                ],
                responses: {
                    '201': {
                        description: 'Credential rotated (includes new private key)',
                        content: {
                            'application/json': {
                                schema: {
                                    allOf: [
                                        { $ref: '#/components/schemas/CredentialWithPrivateKey' },
                                        {
                                            type: 'object',
                                            properties: {
                                                old_credential_id: { type: 'string' },
                                                old_credential_revoked: { type: 'boolean' }
                                            }
                                        }
                                    ]
                                }
                            }
                        }
                    },
                    '400': { description: 'Cannot rotate revoked credential' },
                    '404': { description: 'Credential not found' }
                }
            }
        }
    },
    components: {
        securitySchemes: {
            bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
                description: 'OIDC token or HMAC-SHA256 shared-secret token (with jti claim)'
            }
        },
        schemas: {
            DsParams: {
                type: 'object',
                properties: {
                    ds_key_id: { type: 'integer', minimum: 1, maximum: 9 },
                    rsa_len: { type: 'integer', minimum: 31, maximum: 128 },
                    cipher_c: { type: 'string', description: 'Base64 cipher text' },
                    iv: { type: 'string', description: 'Base64 IV' }
                },
                required: ['ds_key_id', 'rsa_len', 'cipher_c', 'iv']
            },
            Error: {
                type: 'object',
                properties: {
                    error: {
                        type: 'string',
                        description: 'Error message'
                    }
                },
                required: ['error']
            },
            Tenant: {
                type: 'object',
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    name: { type: 'string' },
                    mode: { type: 'string', enum: ['managed', 'byoi', 'byoca', 'hybrid'] },
                    status: { type: 'string', enum: ['active', 'suspended', 'deleted'] },
                    created_at: { type: 'integer' },
                    ca_count: { type: 'integer' },
                    certificate_count: { type: 'integer' }
                }
            },
            CreateTenant: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 255 },
                    mode: { type: 'string', enum: ['managed', 'byoi', 'byoca', 'hybrid'], default: 'managed' }
                },
                required: ['name']
            },
            UpdateTenant: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 255 },
                    status: { type: 'string', enum: ['active', 'suspended'] }
                }
            },
            CA: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    algorithm: { type: 'string', enum: ['rsa', 'ecc'] },
                    key_spec: { type: 'string', enum: ['rsa-2048', 'rsa-3072', 'rsa-4096', 'ecc-p256', 'ecc-p384'] },
                    tier: { type: 'string', enum: ['root', 'intermediate'] },
                    status: { type: 'string', enum: ['active', 'rolling', 'revoked', 'expired'] },
                    not_before: { type: 'integer' },
                    not_after: { type: 'integer' },
                    certificate_pem: { type: 'string' }
                }
            },
            CreatePlatformRoot: {
                type: 'object',
                properties: {
                    algorithm: { type: 'string', enum: ['rsa', 'ecc'] },
                    key_spec: { type: 'string', enum: ['rsa-2048', 'rsa-3072', 'rsa-4096', 'ecc-p256', 'ecc-p384'] },
                    name: { type: 'string', minLength: 1, maxLength: 255 },
                    validity_years: { type: 'integer', minimum: 1, maximum: 30, default: 20 }
                },
                required: ['algorithm', 'key_spec', 'name']
            },
            CreateIntermediate: {
                type: 'object',
                properties: {
                    algorithm: { type: 'string', enum: ['rsa', 'ecc'] },
                    key_spec: { type: 'string', enum: ['rsa-2048', 'rsa-3072', 'rsa-4096', 'ecc-p256', 'ecc-p384'] },
                    root_ca_id: { type: 'string', description: 'ID of the root CA to sign this intermediate' },
                    name: { type: 'string', maxLength: 255 },
                    validity_years: { type: 'integer', minimum: 1, maximum: 20, default: 10 }
                },
                required: ['algorithm', 'key_spec']
            },
            SignCsr: {
                type: 'object',
                properties: {
                    csr: { type: 'string', description: 'PEM-encoded CSR' },
                    chain_algorithm: { type: 'string', enum: ['rsa', 'ecc'], description: 'Algorithm of the signing chain to use' },
                    validity_days: { type: 'integer', minimum: 1, maximum: 3650, default: 365 },
                    device_id: { type: 'string', maxLength: 255 },
                    metadata: { type: 'object', additionalProperties: true }
                },
                required: ['csr']
            },
            RevokeCert: {
                type: 'object',
                properties: {
                    reason: {
                        type: 'string',
                        enum: ['unspecified', 'keyCompromise', 'caCompromise', 'affiliationChanged', 'superseded', 'cessationOfOperation']
                    }
                }
            },
            AssignCa: {
                type: 'object',
                properties: {
                    ca_id: { type: 'integer', description: 'ID of the platform CA to assign' }
                },
                required: ['ca_id']
            },
            Certificate: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    serial_number: { type: 'string' },
                    subject_cn: { type: 'string' },
                    cert_pem: { type: 'string' },
                    not_before: { type: 'integer' },
                    not_after: { type: 'integer' },
                    key_algorithm: { type: 'string', enum: ['rsa', 'ecc'] },
                    chain_algorithm: { type: 'string', enum: ['rsa', 'ecc'] },
                    device_id: { type: 'string' },
                    status: { type: 'string', enum: ['active', 'revoked', 'expired'] },
                    revoked_at: { type: 'integer' },
                    revocation_reason: { type: 'string' }
                }
            },
            AuditEntry: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    timestamp: { type: 'integer' },
                    tenant_id: { type: 'string' },
                    actor: { type: 'string' },
                    action: { type: 'string' },
                    resource_type: { type: 'string' },
                    resource_id: { type: 'string' },
                    details: { type: 'string' }
                }
            },
            UploadRoot: {
                type: 'object',
                properties: {
                    certificate_pem: { type: 'string', description: 'PEM-encoded root CA certificate' },
                    private_key_pem: { type: 'string', description: 'PEM-encoded private key (optional, for signing capability)' },
                    algorithm: { type: 'string', enum: ['rsa', 'ecc'], description: 'Algorithm of the certificate' },
                    name: { type: 'string', maxLength: 255, description: 'Optional name for the CA' }
                },
                required: ['certificate_pem', 'algorithm']
            },
            UploadIntermediate: {
                type: 'object',
                properties: {
                    certificate_pem: { type: 'string', description: 'PEM-encoded intermediate CA certificate' },
                    private_key_pem: { type: 'string', description: 'PEM-encoded private key' },
                    parent_ca_id: { type: 'integer', description: 'ID of the parent CA (root or intermediate)' },
                    name: { type: 'string', maxLength: 255, description: 'Optional name for the CA' }
                },
                required: ['certificate_pem', 'private_key_pem']
            },
            SignIntermediateCsr: {
                type: 'object',
                properties: {
                    csr_pem: { type: 'string', description: 'PEM-encoded CSR for the intermediate CA' },
                    private_key_pem: { type: 'string', description: 'PEM-encoded private key for the intermediate' },
                    root_ca_id: { type: 'integer', description: 'ID of the root CA to sign with' },
                    name: { type: 'string', maxLength: 255, description: 'Optional name for the CA' },
                    validity_years: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: 'Validity period in years' }
                },
                required: ['csr_pem', 'private_key_pem', 'root_ca_id']
            },
            UploadedCa: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    algorithm: { type: 'string', enum: ['rsa', 'ecc'] },
                    tier: { type: 'string', enum: ['root', 'intermediate'] },
                    status: { type: 'string', enum: ['active', 'rolling', 'revoked', 'expired'] },
                    not_before: { type: 'integer' },
                    not_after: { type: 'integer' },
                    certificate_pem: { type: 'string' },
                    can_sign: { type: 'boolean', description: 'Whether this CA has a private key and can sign certificates' }
                }
            },
            CaStatus: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    status: { type: 'string', enum: ['active', 'rolling', 'retired', 'revoked'] },
                    superseded_by: { type: 'integer', description: 'ID of the CA that superseded this one' },
                    cross_signatures: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                signing_ca_id: { type: 'integer' },
                                cross_certificate_pem: { type: 'string' }
                            }
                        }
                    }
                }
            },
            CaStatusResult: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    status: { type: 'string', enum: ['active', 'rolling', 'retired', 'revoked'] },
                    superseded_by: { type: 'integer', description: 'ID of the CA that superseded this one' }
                }
            },
            RollCa: {
                type: 'object',
                properties: {
                    cross_sign: { type: 'boolean', default: true, description: 'Whether old CA should cross-sign new CA' }
                }
            },
            RolledCa: {
                type: 'object',
                properties: {
                    old_ca_id: { type: 'integer' },
                    new_ca_id: { type: 'integer' },
                    new_ca_name: { type: 'string' },
                    new_certificate_pem: { type: 'string' },
                    cross_certificate_pem: { type: 'string', description: 'Cross-signature (old CA signed new CA)' }
                }
            },
            RevokeCa: {
                type: 'object',
                properties: {
                    reason: {
                        type: 'string',
                        enum: ['unspecified', 'keyCompromise', 'caCompromise', 'affiliationChanged', 'superseded', 'cessationOfOperation'],
                        description: 'Revocation reason'
                    }
                }
            },
            TenantStats: {
                type: 'object',
                properties: {
                    certificates: {
                        type: 'object',
                        properties: {
                            total: { type: 'integer' },
                            active: { type: 'integer' },
                            revoked: { type: 'integer' },
                            expired: { type: 'integer' },
                            expiring_30_days: { type: 'integer' }
                        }
                    },
                    cas: {
                        type: 'object',
                        properties: {
                            total: { type: 'integer' },
                            roots: { type: 'integer' },
                            intermediates: { type: 'integer' },
                            active: { type: 'integer' },
                            revoked: { type: 'integer' },
                            by_algorithm: {
                                type: 'object',
                                properties: {
                                    rsa: { type: 'integer' },
                                    ecc: { type: 'integer' }
                                }
                            }
                        }
                    },
                    activity: {
                        type: 'object',
                        properties: {
                            last_24_hours: { type: 'integer' }
                        }
                    },
                    generated_at: { type: 'string', format: 'date-time' }
                }
            },
            AdminStats: {
                type: 'object',
                properties: {
                    tenants: {
                        type: 'object',
                        properties: {
                            total: { type: 'integer' },
                            active: { type: 'integer' },
                            suspended: { type: 'integer' },
                            by_mode: {
                                type: 'object',
                                properties: {
                                    managed: { type: 'integer' },
                                    byoca: { type: 'integer' }
                                }
                            }
                        }
                    },
                    platform_cas: {
                        type: 'object',
                        properties: {
                            total: { type: 'integer' },
                            roots: { type: 'integer' },
                            intermediates: { type: 'integer' },
                            by_algorithm: {
                                type: 'object',
                                properties: {
                                    rsa: { type: 'integer' },
                                    ecc: { type: 'integer' }
                                }
                            }
                        }
                    },
                    tenant_cas: {
                        type: 'object',
                        properties: {
                            total: { type: 'integer' },
                            active: { type: 'integer' }
                        }
                    },
                    certificates: {
                        type: 'object',
                        properties: {
                            total: { type: 'integer' },
                            active: { type: 'integer' },
                            revoked: { type: 'integer' },
                            expired: { type: 'integer' },
                            issued_today: { type: 'integer' }
                        }
                    },
                    activity_24h: {
                        type: 'object',
                        properties: {
                            total: { type: 'integer' },
                            sign_csr: { type: 'integer' },
                            revocations: { type: 'integer' },
                            creations: { type: 'integer' }
                        }
                    },
                    generated_at: { type: 'string', format: 'date-time' }
                }
            },
            Credential: {
                type: 'object',
                description: 'Signing credential for M2M authentication (WeatherKit model)',
                properties: {
                    id: { type: 'string', format: 'uuid', description: 'Credential ID, used as kid in JWT header' },
                    name: { type: 'string', description: 'Human-readable name for the credential' },
                    algorithm: { type: 'string', enum: ['ES256', 'ES384'], description: 'JWT signing algorithm' },
                    public_key_pem: { type: 'string', description: 'PEM-encoded public key for verification' },
                    permissions: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Permissions granted to this credential'
                    },
                    created_at: { type: 'integer', description: 'Unix timestamp of creation' },
                    created_by: { type: 'string', description: 'Actor who created this credential' },
                    last_used_at: { type: 'integer', description: 'Unix timestamp of last use' },
                    expires_at: { type: 'integer', description: 'Unix timestamp of expiration (null = no expiration)' },
                    revoked_at: { type: 'integer', description: 'Unix timestamp of revocation (null = active)' }
                }
            },
            CredentialWithPrivateKey: {
                type: 'object',
                description: 'Credential including private key (only returned at creation/rotation)',
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    name: { type: 'string' },
                    algorithm: { type: 'string', enum: ['ES256', 'ES384'] },
                    public_key_pem: { type: 'string' },
                    private_key_pem: { type: 'string', description: 'PEM-encoded private key (SHOWN ONLY ONCE)' },
                    permissions: { type: 'array', items: { type: 'string' } },
                    created_at: { type: 'integer' },
                    expires_at: { type: 'integer' }
                }
            },
            CreateCredential: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 255, description: 'Unique name for this credential' },
                    permissions: {
                        type: 'array',
                        items: { type: 'string' },
                        default: ['*'],
                        description: 'Permissions: * (all), sign:*, sign:rsa, sign:ecc, certs:read, certs:revoke, cas:read, cas:manage'
                    },
                    algorithm: { type: 'string', enum: ['ES256', 'ES384'], default: 'ES256' },
                    expires_in_days: { type: 'integer', minimum: 1, description: 'Days until expiration (null = no expiration)' }
                }
            }
        }
    }
} as const

export type SwaggerDocument = typeof swaggerDocument
